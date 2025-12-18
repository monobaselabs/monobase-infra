#!/usr/bin/env bun
/**
 * Provision Script - Unified Cluster Provisioning and Destruction
 *
 * Replaces:
 * - scripts/provision.sh
 * - scripts/teardown.sh
 *
 * Features:
 * - Cluster provisioning with Terraform/OpenTofu
 * - Kubeconfig extraction and merging
 * - Cluster connectivity verification
 * - Cluster destruction with state backup
 * - Interactive prompts with validation
 * - Progress indicators and colored output
 *
 * Usage:
 *   bun scripts/provision.ts                                     # Provision cluster
 *   bun scripts/provision.ts --merge-kubeconfig                  # Provision + merge config
 *   bun scripts/provision.ts --destroy                           # Destroy cluster
 *   bun scripts/provision.ts --destroy --dry-run                 # Preview destruction
 */

import { $ } from "bun";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { parseArgs } from "util";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { ClusterSetupWizard } from "./lib/wizard/index";

// ===== Types =====

interface ProvisionConfig {
  dryRun: boolean;
  autoApprove: boolean;
  mergeKubeconfig: boolean;
  destroy: boolean;
  keepKubeconfig: boolean;
}

interface WizardFlags {
  provider?: string;
  projectId?: string;
  region?: string;
  clusterName?: string;
  deploymentProfile?: string;
}

// ===== Provision Class =====

class ClusterProvisioner {
  private config: ProvisionConfig;
  private wizardFlags: WizardFlags;
  private clusterDir: string = '';
  private terraformCmd: string = '';

  constructor(config: ProvisionConfig, wizardFlags: WizardFlags = {}) {
    this.config = config;
    this.wizardFlags = wizardFlags;
  }

  async run() {
    try {
      this.printHeader();

      if (this.config.destroy) {
        await this.destroy();
      } else {
        await this.provision();
      }
    } catch (error) {
      console.error(chalk.red('\n✗ Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  // ===== Provision Flow =====

  async provision() {
    console.log(chalk.blue('\n==> Provision Configuration'));
    console.log(`Cluster directory: cluster/`);
    console.log(`Merge kubeconfig: ${this.config.mergeKubeconfig}`);
    console.log(`Auto-approve: ${this.config.autoApprove}`);
    console.log(`Dry run: ${this.config.dryRun}`);

    await this.validatePrerequisites();
    await this.validateClusterDirectory();
    await this.validateGcpApis();
    await this.terraformInit();
    await this.terraformPlan();

    if (!this.config.dryRun) {
      await this.confirmApply();
      await this.terraformApply();
      await this.extractKubeconfig();

      if (this.config.mergeKubeconfig) {
        await this.mergeKubeconfig();
      }

      await this.verifyConnectivity();
    }

    await this.displayProvisionSummary();
  }

  // ===== Validation =====

  async validatePrerequisites() {
    console.log(chalk.blue('\n==> Step 1: Validate Prerequisites'));

    // Check for terraform or tofu
    try {
      await $`terraform version`.quiet();
      this.terraformCmd = 'terraform';
      console.log(chalk.green('✓ terraform found'));
    } catch {
      try {
        await $`tofu version`.quiet();
        this.terraformCmd = 'tofu';
        console.log(chalk.green('✓ tofu (OpenTofu) found'));
      } catch {
        throw new Error('Neither terraform nor tofu found in PATH');
      }
    }

    // Check kubectl
    try {
      await $`kubectl version --client --output=json`.quiet();
      console.log(chalk.green('✓ kubectl found'));
    } catch {
      throw new Error('kubectl not found in PATH');
    }
  }

  // ===== Cluster Directory Validation =====

  async validateClusterDirectory() {
    this.clusterDir = 'values/cluster';

    if (!existsSync(this.clusterDir)) {
      console.log(chalk.yellow('\n✗ No cluster configuration found'));
      console.log(chalk.blue('Launching interactive setup wizard...\n'));

      // Launch interactive setup wizard
      const wizard = new ClusterSetupWizard(this.wizardFlags);
      await wizard.run();

      // After wizard completes, verify cluster directory was created
      if (!existsSync(this.clusterDir)) {
        throw new Error('Wizard did not create cluster directory');
      }
    }

    // Check for required Terraform files
    const requiredFiles = ['main.tf'];
    const missingFiles = requiredFiles.filter(file =>
      !existsSync(join(this.clusterDir, file))
    );

    if (missingFiles.length > 0) {
      throw new Error(`Missing required files in ${this.clusterDir}: ${missingFiles.join(', ')}`);
    }

    console.log(chalk.green(`✓ Cluster directory validated: ${this.clusterDir}`));
  }

  // ===== GCP API Validation =====

  async validateGcpApis() {
    // Check if this is a GCP cluster by looking for project_id in tfvars
    const tfvarsPath = join(this.clusterDir, 'terraform.tfvars');

    if (!existsSync(tfvarsPath)) {
      return; // No tfvars file, skip GCP validation
    }

    const tfvarsContent = await Bun.file(tfvarsPath).text();
    const projectIdMatch = tfvarsContent.match(/project_id\s*=\s*"([^"]+)"/);

    if (!projectIdMatch) {
      return; // Not a GCP cluster, skip
    }

    const projectId = projectIdMatch[1];
    console.log(chalk.blue('\n==> Step 2: Validate GCP APIs'));

    // Check if gcloud is available
    try {
      await $`gcloud --version`.quiet();
    } catch {
      console.log(chalk.yellow('⚠️  gcloud CLI not found, skipping API validation'));
      console.log(chalk.gray('   APIs will be checked when Terraform runs'));
      return;
    }

    const spinner = ora('Checking required GCP APIs...').start();

    try {
      // Check if required APIs are enabled
      const requiredApis = [
        'compute.googleapis.com',
        'container.googleapis.com',
        'iam.googleapis.com',
      ];

      const apiStatus = await $`gcloud services list --enabled --project=${projectId} --format=json`.text();
      const enabledApis = JSON.parse(apiStatus);
      const enabledApiNames = enabledApis.map((api: any) => api.config.name);

      const missingApis = requiredApis.filter(api => !enabledApiNames.includes(api));

      if (missingApis.length === 0) {
        spinner.succeed('Required GCP APIs are enabled');
        return;
      }

      spinner.info(`${missingApis.length} API(s) need to be enabled`);

      console.log(chalk.yellow('\nRequired APIs not yet enabled:'));
      missingApis.forEach(api => console.log(chalk.gray(`  - ${api}`)));

      // Enable the APIs
      const enableSpinner = ora('Enabling GCP APIs...').start();

      try {
        await $`gcloud services enable ${missingApis.join(' ')} --project=${projectId}`.quiet();
        enableSpinner.succeed('GCP APIs enabled successfully');
      } catch (error) {
        enableSpinner.fail('Failed to enable APIs');
        console.log(chalk.yellow('\n⚠️  Could not enable APIs automatically'));
        console.log(chalk.gray('   Please run manually:'));
        console.log(chalk.cyan(`   gcloud services enable ${missingApis.join(' ')} --project=${projectId}`));
        throw new Error('Required GCP APIs are not enabled');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Required GCP APIs')) {
        throw error;
      }
      spinner.fail('API validation failed');
      console.log(chalk.yellow('⚠️  Could not validate GCP APIs, continuing anyway...'));
    }
  }

  // ===== Terraform Operations =====

  async terraformInit() {
    console.log(chalk.blue('\n==> Step 3: Terraform Init'));

    const spinner = ora('Initializing Terraform...').start();

    try {
      const result = await $`cd ${this.clusterDir} && ${this.terraformCmd} init`.text();

      if (result.includes('Terraform has been successfully initialized')) {
        spinner.succeed('Terraform initialized');
      } else if (result.includes('has been successfully initialized')) {
        spinner.succeed('Terraform already initialized');
      } else {
        spinner.succeed('Terraform init complete');
      }
    } catch (error) {
      spinner.fail('Terraform init failed');
      throw error;
    }
  }

  async terraformPlan() {
    console.log(chalk.blue('\n==> Step 4: Terraform Plan'));

    const spinner = ora('Generating plan...').start();
    const planFile = 'tfplan';

    try {
      const result = await $`cd ${this.clusterDir} && ${this.terraformCmd} plan -out=${planFile}`.text();

      spinner.succeed('Plan generated');

      // Parse plan output for changes
      const lines = result.split('\n');
      const planSummary = lines.find(line =>
        line.includes('Plan:') || line.includes('No changes')
      );

      if (planSummary) {
        console.log(chalk.cyan(`\n${planSummary.trim()}`));
      }

      // Show if this is first run
      if (result.includes('Plan: ') && result.includes(' to add')) {
        const match = result.match(/Plan: (\d+) to add/);
        if (match && parseInt(match[1]) > 0) {
          console.log(chalk.yellow('\n⚠️  This appears to be a first-time provision'));
        }
      }

      if (this.config.dryRun) {
        console.log(chalk.gray('\nDry run: Plan saved but will not be applied'));
      }
    } catch (error) {
      spinner.fail('Plan generation failed');
      throw error;
    }
  }

  async confirmApply() {
    if (this.config.autoApprove) {
      console.log(chalk.yellow('\n⚠️  Auto-approve enabled, applying changes...'));
      return;
    }

    console.log(chalk.blue('\n==> Confirm Apply'));

    const confirmed = await confirm({
      message: 'Do you want to apply these changes?',
      default: false
    });

    if (!confirmed) {
      throw new Error('Apply cancelled by user');
    }
  }

  async terraformApply() {
    console.log(chalk.blue('\n==> Step 5: Terraform Apply'));

    const spinner = ora('Applying infrastructure changes...').start();

    try {
      await $`cd ${this.clusterDir} && ${this.terraformCmd} apply tfplan`.quiet();
      spinner.succeed('Infrastructure provisioned successfully');

      // Clean up plan file
      try {
        await $`cd ${this.clusterDir} && rm -f tfplan`.quiet();
      } catch {}
    } catch (error) {
      spinner.fail('Terraform apply failed');
      throw error;
    }
  }

  // ===== Kubeconfig Management =====

  async extractKubeconfig() {
    console.log(chalk.blue('\n==> Step 6: Extract Kubeconfig'));

    const spinner = ora('Configuring kubectl...').start();

    try {
      // Get the kubectl configuration command from terraform
      const configureCmd = await $`cd ${this.clusterDir} && ${this.terraformCmd} output -raw configure_kubectl`.text();

      // Execute the gcloud command to configure kubectl
      await $`${configureCmd}`.quiet();

      spinner.succeed('Kubectl configured successfully');

      const clusterName = await this.getClusterName();
      console.log(chalk.gray(`Context: ${clusterName}`));
      console.log(chalk.gray(`Kubeconfig: ~/.kube/config`));
    } catch (error) {
      spinner.fail('Failed to configure kubectl');
      throw error;
    }
  }

  async mergeKubeconfig() {
    console.log(chalk.blue('\n==> Step 7: Merge Kubeconfig'));

    const spinner = ora('Checking existing contexts...').start();
    const clusterName = await this.getClusterName();

    try {
      // Check if context already exists
      try {
        await $`kubectl config get-contexts ${clusterName}`.quiet();
        spinner.info(`Context '${clusterName}' already exists in ~/.kube/config`);

        const switchContext = await confirm({
          message: `Switch to context '${clusterName}'?`,
          default: true
        });

        if (switchContext) {
          await $`kubectl config use-context ${clusterName}`.quiet();
          console.log(chalk.green(`✓ Switched to context: ${clusterName}`));
        }

        return;
      } catch {
        // Context doesn't exist, merge it
      }

      spinner.text = 'Merging kubeconfig...';

      // Backup existing config
      const backupPath = join(process.env.HOME || '~', '.kube', `config.backup.${Date.now()}`);
      try {
        await $`cp ~/.kube/config ${backupPath}`.quiet();
        console.log(chalk.gray(`Backup created: ${backupPath}`));
      } catch {}

      // Merge configs
      const kubeconfigPath = join(process.env.HOME || '~', '.kube', clusterName);
      await $`KUBECONFIG=~/.kube/config:${kubeconfigPath} kubectl config view --flatten > ~/.kube/config.tmp`.quiet();
      await $`mv ~/.kube/config.tmp ~/.kube/config`.quiet();

      // Switch to new context
      await $`kubectl config use-context ${clusterName}`.quiet();

      spinner.succeed(`Kubeconfig merged and switched to context: ${clusterName}`);
    } catch (error) {
      spinner.fail('Failed to merge kubeconfig');
      throw error;
    }
  }

  async verifyConnectivity() {
    console.log(chalk.blue('\n==> Step 8: Verify Connectivity'));

    const spinner = ora('Testing cluster connection...').start();
    const clusterName = await this.getClusterName();
    const kubeconfigPath = join(process.env.HOME || '~', '.kube', clusterName);

    try {
      // Test connection
      await $`KUBECONFIG=${kubeconfigPath} kubectl cluster-info`.quiet();
      spinner.text = 'Fetching node status...';

      // Get nodes
      const nodes = await $`KUBECONFIG=${kubeconfigPath} kubectl get nodes`.text();

      spinner.succeed('Cluster is accessible');
      console.log(chalk.blue('\nNode Status:'));
      console.log(nodes);
    } catch (error) {
      spinner.fail('Failed to connect to cluster');
      throw error;
    }
  }

  async displayProvisionSummary() {
    console.log(chalk.blue('\n==> Provision Summary'));

    if (this.config.dryRun) {
      console.log(chalk.yellow('Dry run completed - no changes applied'));
      return;
    }

    try {
      const outputs = await $`cd ${this.clusterDir} && ${this.terraformCmd} output -json`.text();
      const parsed = JSON.parse(outputs);

      console.log(chalk.blue('\nTerraform Outputs:'));
      Object.entries(parsed).forEach(([key, value]: [string, any]) => {
        if (key !== 'kubeconfig' && value.value) {
          console.log(`  ${chalk.cyan(key)}: ${value.value}`);
        }
      });
    } catch {
      console.log(chalk.yellow('Could not fetch terraform outputs'));
    }

    console.log(chalk.blue('\n==> Next Steps'));
    const clusterName = await this.getClusterName();
    const kubeconfigPath = join(process.env.HOME || '~', '.kube', clusterName);
    console.log(`1. Export kubeconfig: export KUBECONFIG=${kubeconfigPath}`);
    console.log(`2. Bootstrap cluster: mise run bootstrap`);
    console.log(`3. Monitor deployments: kubectl get nodes`);
  }

  // ===== Destroy Flow =====

  async destroy() {
    console.log(chalk.red('\n==> Cluster Destruction'));
    console.log(chalk.yellow('⚠️  This will destroy all cluster infrastructure\n'));

    await this.validatePrerequisites();
    await this.validateClusterDirectory();
    await this.checkTerraformState();
    await this.terraformInit();
    await this.showDestroyPlan();

    if (!this.config.dryRun) {
      await this.confirmDestruction();
      await this.backupState();
      await this.terraformDestroy();

      if (!this.config.keepKubeconfig) {
        await this.cleanupKubeconfig();
      }
    }

    await this.displayDestroySummary();
  }

  async checkTerraformState() {
    const stateFile = join(this.clusterDir, 'terraform.tfstate');

    if (!existsSync(stateFile)) {
      console.log(chalk.yellow('\n⚠️  Warning: terraform.tfstate not found'));
      console.log(chalk.yellow('No infrastructure state detected for this cluster'));

      if (!this.config.autoApprove) {
        const continueAnyway = await confirm({
          message: 'Continue anyway?',
          default: false
        });

        if (!continueAnyway) {
          throw new Error('Destruction cancelled');
        }
      }
    } else {
      console.log(chalk.green('✓ Terraform state found'));
    }
  }

  async showDestroyPlan() {
    console.log(chalk.blue('\n==> Destroy Plan'));

    const spinner = ora('Generating destroy plan...').start();

    try {
      const result = await $`cd ${this.clusterDir} && ${this.terraformCmd} plan -destroy`.text();

      spinner.succeed('Destroy plan generated');

      // Parse plan output for changes
      const lines = result.split('\n');
      const planSummary = lines.find(line =>
        line.includes('Plan:') || line.includes('No changes')
      );

      if (planSummary) {
        console.log(chalk.red(`\n${planSummary.trim()}`));
      }

      if (this.config.dryRun) {
        console.log(chalk.gray('\nDry run: Plan generated but will not be executed'));
      }
    } catch (error) {
      spinner.fail('Destroy plan generation failed');
      throw error;
    }
  }

  async confirmDestruction() {
    console.log(chalk.red('\n==> Confirmation Required'));
    console.log(chalk.yellow('⚠️  This action is IRREVERSIBLE'));
    console.log(chalk.yellow('⚠️  All cluster resources will be permanently deleted\n'));

    const clusterName = await this.getClusterName();

    // First confirmation: Type cluster name
    await input({
      message: `Type the cluster name '${chalk.red(clusterName)}' to confirm:`,
      validate: (val) => val === clusterName || `Must type exactly: ${clusterName}`
    });

    // Second confirmation: Type DESTROY
    await input({
      message: `Type ${chalk.red('DESTROY')} to proceed:`,
      validate: (val) => val === 'DESTROY' || 'Must type exactly: DESTROY'
    });

    console.log(chalk.red('\n⚠️  Proceeding with destruction...'));
  }

  async backupState() {
    console.log(chalk.blue('\n==> Backing Up State'));

    const spinner = ora('Creating state backup...').start();

    try {
      const clusterName = await this.getClusterName();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = 'backups/terraform-state';
      const backupFile = `${clusterName}-${timestamp}.tfstate`;

      await $`mkdir -p ${backupDir}`.quiet();
      await $`cp ${this.clusterDir}/terraform.tfstate ${backupDir}/${backupFile}`.quiet();

      spinner.succeed(`State backed up: ${backupDir}/${backupFile}`);
    } catch (error) {
      spinner.warn('State backup failed (continuing anyway)');
    }
  }

  async terraformDestroy() {
    console.log(chalk.blue('\n==> Destroying Infrastructure'));

    const spinner = ora('Running terraform destroy...').start();

    try {
      await $`cd ${this.clusterDir} && ${this.terraformCmd} destroy -auto-approve`.quiet();
      spinner.succeed('Infrastructure destroyed successfully');
    } catch (error) {
      spinner.fail('Terraform destroy failed');
      console.log(chalk.yellow('\n⚠️  Check state backup in backups/terraform-state/'));
      throw error;
    }
  }

  async cleanupKubeconfig() {
    console.log(chalk.blue('\n==> Cleaning Up Kubeconfig'));

    const spinner = ora('Removing kubeconfig files...').start();
    const clusterName = await this.getClusterName();
    const kubeconfigPath = join(process.env.HOME || '~', '.kube', clusterName);

    try {
      // Remove standalone kubeconfig file
      try {
        await $`rm -f ${kubeconfigPath}`.quiet();
        spinner.succeed(`Removed: ${kubeconfigPath}`);
      } catch {}

      // Check if context exists in merged config
      try {
        await $`kubectl config get-contexts ${clusterName}`.quiet();

        const removeContext = await confirm({
          message: `Remove context '${clusterName}' from ~/.kube/config?`,
          default: true
        });

        if (removeContext) {
          await $`kubectl config delete-context ${clusterName}`.quiet();
          await $`kubectl config delete-cluster ${clusterName}`.quiet();
          await $`kubectl config delete-user ${clusterName}`.quiet();
          console.log(chalk.green('✓ Context removed from ~/.kube/config'));
        }
      } catch {
        // Context doesn't exist in merged config
      }
    } catch (error) {
      spinner.warn('Kubeconfig cleanup had issues');
    }
  }

  async displayDestroySummary() {
    console.log(chalk.blue('\n==> Destruction Summary'));

    if (this.config.dryRun) {
      console.log(chalk.yellow('Dry run completed - no resources destroyed'));
      return;
    }

    console.log(chalk.green('✓ Cluster infrastructure destroyed'));
    console.log(chalk.gray('\nState backup location: backups/terraform-state/'));

    if (this.config.keepKubeconfig) {
      const clusterName = await this.getClusterName();
      const kubeconfigPath = join(process.env.HOME || '~', '.kube', clusterName);
      console.log(chalk.yellow(`\nKubeconfig preserved: ${kubeconfigPath}`));
    }
  }

  // ===== Utility =====

  async getClusterName(): Promise<string> {
    // Try to extract cluster name from terraform.tfvars
    const tfvarsPath = join(this.clusterDir, 'terraform.tfvars');
    
    try {
      if (existsSync(tfvarsPath)) {
        const content = await Bun.file(tfvarsPath).text();
        const match = content.match(/cluster_name\s*=\s*"([^"]+)"/);
        if (match) {
          return match[1];
        }
      }
    } catch {}

    // Fallback: use cluster directory name
    return 'cluster';
  }

  printHeader() {
    const title = this.config.destroy ? 'Cluster Destruction' : 'Cluster Provisioning';
    console.log(chalk.bold.blue('\n╔════════════════════════════════════════╗'));
    console.log(chalk.bold.blue(`║  ${title.padEnd(36)} ║`));
    console.log(chalk.bold.blue('╚════════════════════════════════════════╝\n'));
  }
}

// ===== CLI Parsing =====

function printHelp() {
  console.log(`
${chalk.bold('Monobase Infrastructure Provisioning')}

${chalk.bold('USAGE:')}
  bun scripts/provision.ts [OPTIONS]

${chalk.bold('PREREQUISITES:')}
  Copy an example cluster configuration to cluster/ directory:
    ${chalk.cyan('cp -r terraform/examples/aws-eks cluster')}
    ${chalk.cyan('cp -r terraform/examples/do-doks cluster')}
    ${chalk.cyan('cp -r terraform/examples/k3d cluster')}

${chalk.bold('OPTIONS:')}
  ${chalk.cyan('--help')}                    Show this help message
  ${chalk.cyan('--dry-run')}                 Preview changes without executing
  ${chalk.cyan('--auto-approve, --yes')}     Skip confirmation prompts
  ${chalk.cyan('--merge-kubeconfig')}        Merge kubeconfig into ~/.kube/config

  ${chalk.bold('Destroy Options:')}
  ${chalk.cyan('--destroy')}                 Destroy cluster infrastructure
  ${chalk.cyan('--keep-kubeconfig')}         Don't remove kubeconfig files (destroy mode)

  ${chalk.bold('Wizard Automation (bypass interactive prompts):')}
  ${chalk.cyan('--provider <provider>')}     Cloud provider (aws-eks, do-doks, gcp-gke, k3d)
  ${chalk.cyan('--project-id <id>')}         GCP project ID (GKE only)
  ${chalk.cyan('--region <region>')}         Cloud region
  ${chalk.cyan('--cluster-name <name>')}     Cluster name (default: monobase-main)
  ${chalk.cyan('--deployment-profile <size>')} Deployment size (small, medium, large)

${chalk.bold('EXAMPLES:')}
  ${chalk.gray('# Setup cluster configuration')}
  cp -r terraform/examples/aws-eks cluster
  cd cluster && vim terraform.tfvars

  ${chalk.gray('# Provision cluster')}
  bun scripts/provision.ts

  ${chalk.gray('# Provision with kubeconfig merge')}
  bun scripts/provision.ts --merge-kubeconfig

  ${chalk.gray('# Dry run provision')}
  bun scripts/provision.ts --dry-run

  ${chalk.gray('# Destroy cluster (interactive)')}
  bun scripts/provision.ts --destroy

  ${chalk.gray('# Preview destroy plan')}
  bun scripts/provision.ts --destroy --dry-run
`);
}

function parseCliArgs(): { config: ProvisionConfig; wizardFlags: WizardFlags } {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'auto-approve': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false }, // Alias for auto-approve
      'merge-kubeconfig': { type: 'boolean', default: false },
      destroy: { type: 'boolean', default: false },
      'keep-kubeconfig': { type: 'boolean', default: false },
      // Wizard flags
      provider: { type: 'string' },
      'project-id': { type: 'string' },
      region: { type: 'string' },
      'cluster-name': { type: 'string' },
      'deployment-profile': { type: 'string' },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  return {
    config: {
      dryRun: values['dry-run'] || false,
      autoApprove: values['auto-approve'] || values.yes || false,
      mergeKubeconfig: values['merge-kubeconfig'] || false,
      destroy: values.destroy || false,
      keepKubeconfig: values['keep-kubeconfig'] || false,
    },
    wizardFlags: {
      provider: values.provider as string | undefined,
      projectId: values['project-id'] as string | undefined,
      region: values.region as string | undefined,
      clusterName: values['cluster-name'] as string | undefined,
      deploymentProfile: values['deployment-profile'] as string | undefined,
    },
  };
}

// ===== Main =====

async function main() {
  const { config, wizardFlags } = parseCliArgs();
  const provisioner = new ClusterProvisioner(config, wizardFlags);
  await provisioner.run();
}

main();
