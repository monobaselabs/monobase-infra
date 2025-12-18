#!/usr/bin/env bun
/**
 * Secrets Management CLI
 * Values-driven secrets management with automatic discovery
 */

import { parseArgs } from "util";
import {
  intro,
  outro,
  log,
  logError,
  logInfo,
  logWarning,
  logSuccess,
  promptText,
  promptPassword,
  promptConfirm,
  clack,
} from "@/lib/prompts";
import {
  scanValuesFiles,
  groupByDeployment,
  filterGeneratable,
  type DiscoveredSecret,
} from "@/secrets/scanner";
import { SecretProvider, detectGCPProjectId, readProjectIdFromValues } from "@/secrets/provider";
import { generateSecretValue, formatSecretDescription } from "@/secrets/generator";
import {
  readClusterSecretStoreFromValues,
  checkClusterSecretStoreStatus,
  checkExternalSecretsOperator,
  generateSetupInstructions,
  checkServiceAccountKeySecret,
  saveClusterSecretStoreConfig,
  checkGCloudReady,
  createGCPServiceAccountAndKey,
  listGCPProjects,
  type ClusterSecretStoreConfig,
} from "@/secrets/configurator";
import { validateExternalSecrets } from "@/secrets/validator";

// Parse command-line arguments
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    deployment: { type: "string", short: "d" },
    project: { type: "string", short: "p" },
    kubeconfig: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

const command = positionals[0] || "help";

// Show help
if (values.help || command === "help") {
  console.log(`
Secrets Management CLI - Values-Driven Architecture

Usage: bun scripts/secrets.ts <command> [options]

Commands:
  discover [--deployment=X]  Discover all secrets from values files
  check [--deployment=X]      Compare values vs GCP Secret Manager
  setup [--project=X]         Initialize ClusterSecretStore
  generate [--deployment=X]   Create missing secrets in GCP
  validate [--deployment=X]   Verify ExternalSecret sync status
  sync                        Full workflow: discover → check → generate → validate

Options:
  -d, --deployment <name>  Filter by specific deployment
  -p, --project <id>       GCP project ID (auto-detects if not provided)
  --kubeconfig <path>      Path to kubeconfig
  --dry-run                Show what would be done without making changes
  -y, --yes                Skip confirmation prompts
  -h, --help               Show this help message

Examples:
  # Discover all secrets from values files
  bun scripts/secrets.ts discover

  # Check which secrets exist in GCP
  bun scripts/secrets.ts check

  # Generate missing secrets for staging deployment
  bun scripts/secrets.ts generate --deployment=acme-staging

  # Validate ExternalSecret sync status
  bun scripts/secrets.ts validate

  # Full sync workflow
  bun scripts/secrets.ts sync --project=monobase-prod
`);
  process.exit(0);
}

/**
 * Discover command - scan values files and show all secrets
 */
async function discoverCommand() {
  intro("🔍 Discovering secrets from values files");

  const spinner = clack.spinner();
  spinner.start("Scanning values files...");

  const results = await scanValuesFiles({
    deployment: values.deployment as string | undefined,
  });

  spinner.stop("Scan complete");

  if (results.totalSecrets === 0) {
    logWarning("No secrets found with externalSecrets.enabled = true");
    outro("🔍 Discovery complete");
    return;
  }

  // Group by deployment
  const grouped = groupByDeployment(results.secrets);

  logInfo(`Found ${results.totalSecrets} secrets across ${grouped.size} deployments`);
  logInfo(`Secrets with generator: ${results.secretsWithGenerator}`);

  // Display grouped results
  for (const [deployment, secrets] of grouped.entries()) {
    log(`\n📦 ${deployment} (${secrets.length} secrets):`);

    for (const secret of secrets) {
      const generatorInfo = secret.generator?.generate
        ? ` [${formatSecretDescription(secret.generator)}]`
        : "";

      log(`   ${secret.chart}: ${secret.remoteKey}${generatorInfo}`);
    }
  }

  outro("🔍 Discovery complete");
}

/**
 * Check command - compare values vs GCP Secret Manager
 */
async function checkCommand() {
  intro("🔎 Checking secrets in GCP Secret Manager");

  // Check if ClusterSecretStore is configured (blocking requirement)
  const config = readClusterSecretStoreFromValues();
  if (!config || !config.projectId) {
    logError("ClusterSecretStore not configured in values/infrastructure/main.yaml");
    logInfo("Run setup first: bun scripts/secrets.ts setup");
    process.exit(1);
  }

  const kubeconfigPath = values.kubeconfig as string | undefined;

  // Get project ID with new priority order
  let projectId = (values.project as string) || await detectGCPProjectId(kubeconfigPath);

  if (!projectId) {
    projectId = await promptText({
      message: "GCP Project ID:",
      placeholder: "monobase-prod",
      validate: (value) => (value ? undefined : "Project ID is required"),
    });
  }

  logInfo(`Using GCP project: ${projectId}`);

  // Scan values files
  const spinner = clack.spinner();
  spinner.start("Scanning values files...");

  const results = await scanValuesFiles({
    deployment: values.deployment as string | undefined,
  });

  spinner.stop(`Found ${results.totalSecrets} secrets`);

  if (results.totalSecrets === 0) {
    logWarning("No secrets found");
    outro("🔎 Check complete");
    return;
  }

  // Initialize provider
  const provider = new SecretProvider(projectId);

  if (!values["dry-run"]) {
    spinner.start("Initializing GCP provider...");
    try {
      await provider.initialize();
      spinner.stop("GCP provider ready");
    } catch (error: any) {
      spinner.stop("Failed to initialize GCP provider");
      logError(error.message);
      process.exit(1);
    }
  }

  // Check all secrets
  const remoteKeys = results.secrets.map((s) => s.remoteKey);
  spinner.start(`Checking ${remoteKeys.length} secrets...`);

  const statuses = values["dry-run"]
    ? new Map()
    : await provider.checkSecrets(remoteKeys);

  spinner.stop("Check complete");

  // Analyze results
  const grouped = groupByDeployment(results.secrets);
  let totalExists = 0;
  let totalMissing = 0;

  for (const [deployment, secrets] of grouped.entries()) {
    log(`\n📦 ${deployment}:`);

    for (const secret of secrets) {
      const status = statuses.get(secret.remoteKey);
      const exists = status?.exists || false;

      if (exists) {
        totalExists++;
        logSuccess(`   ✓ ${secret.chart}: ${secret.remoteKey}`);
      } else {
        totalMissing++;
        const generatorInfo = secret.generator?.generate ? " (can generate)" : " (needs manual input)";
        logWarning(`   ✗ ${secret.chart}: ${secret.remoteKey}${generatorInfo}`);
      }
    }
  }

  log("");
  logInfo(`Total: ${totalExists} exist, ${totalMissing} missing`);

  outro("🔎 Check complete");
}

/**
 * Setup command - initialize ClusterSecretStore
 */
async function setupCommand() {
  intro("⚙️  Setting up ClusterSecretStore");

  const kubeconfigPath = values.kubeconfig as string | undefined;

  // Step 1: Check if External Secrets Operator is installed (blocking)
  if (!values["dry-run"]) {
    const spinner = clack.spinner();
    spinner.start("Checking External Secrets Operator...");

    const esoStatus = await checkExternalSecretsOperator(kubeconfigPath);

    if (!esoStatus.installed) {
      spinner.stop("External Secrets Operator not found");
      logError("External Secrets Operator is not installed");
      logInfo("Install via ArgoCD: argocd/infrastructure/templates/external-secrets.yaml");
      process.exit(1);
    }

    spinner.stop(`✓ External Secrets Operator installed (${esoStatus.version || "unknown version"})`);
  }

  // Step 2: Check if config already exists in values file
  const existingConfig = readClusterSecretStoreFromValues();

  if (existingConfig && existingConfig.projectId) {
    logInfo("ClusterSecretStore already configured:");
    logInfo(`  Provider: ${existingConfig.provider}`);
    logInfo(`  Name: ${existingConfig.name}`);
    logInfo(`  Project ID: ${existingConfig.projectId}`);

    // Check if ClusterSecretStore exists in cluster
    if (!values["dry-run"]) {
      const spinner = clack.spinner();
      spinner.start("Checking cluster status...");
      const storeStatus = await checkClusterSecretStoreStatus(existingConfig.name, kubeconfigPath);
      spinner.stop();

      if (storeStatus.exists) {
        if (storeStatus.ready) {
          logSuccess(`✓ ClusterSecretStore "${existingConfig.name}" is ready`);
        } else {
          logWarning(`⚠ ClusterSecretStore "${existingConfig.name}" exists but not ready`);
          if (storeStatus.errorMessage) {
            logError(`  Error: ${storeStatus.errorMessage}`);
          }
        }
      } else {
        logWarning(`ClusterSecretStore "${existingConfig.name}" not found in cluster`);
        logInfo("ArgoCD will create it from values/infrastructure/main.yaml");
      }

      // Check service account key secret
      const keySecretExists = await checkServiceAccountKeySecret(kubeconfigPath);
      if (keySecretExists) {
        logSuccess("✓ Service account key secret exists (gcpsm-secret)");
      } else {
        logWarning("⚠ Service account key secret not found (gcpsm-secret)");
        logInfo("Create it manually: kubectl create secret generic gcpsm-secret ...");
      }
    }

    outro("⚙️  Setup already complete");
    return;
  }

  // Step 3: Get GCP project ID (always prompt unless CLI flag provided)
  let projectId = values.project as string;

  if (!projectId) {
    // List available projects and let user select
    const availableProjects = await listGCPProjects();
    
    if (availableProjects.length > 0) {
      // Use interactive selection
      projectId = await clack.select({
        message: "Select GCP Project:",
        options: availableProjects.map(p => ({ value: p, label: p })),
      }) as string;
    } else {
      // Fallback to text input if listing fails
      projectId = await promptText({
        message: "GCP Project ID:",
        placeholder: "my-project-123",
        validate: (value) => (value ? undefined : "Project ID is required"),
      });
    }
  }

  logInfo(`Using GCP project: ${projectId}`);

  if (values["dry-run"]) {
    logInfo("[DRY RUN] Skipping service account and secret creation");
    outro("⚙️  Dry run complete");
    return;
  }

  // Step 4: Check gcloud CLI installation and authentication
  const spinner = clack.spinner();
  spinner.start("Checking gcloud CLI...");

  const gcloudStatus = await checkGCloudReady();

  if (!gcloudStatus.installed) {
    spinner.stop("gcloud CLI not found");
    logError("gcloud CLI is not installed");
    logInfo("Install from: https://cloud.google.com/sdk/docs/install");
    process.exit(1);
  }

  if (!gcloudStatus.authenticated) {
    spinner.stop("Not authenticated to GCP");
    logError("Not authenticated to gcloud");
    logInfo("Run: gcloud auth login");
    process.exit(1);
  }

  spinner.stop(`✓ gcloud CLI ready (${gcloudStatus.activeAccount})`);

  // Step 5: Create GCP service account and key automatically
  log("");
  log("🔧 Creating GCP service account...");

  let keyFilePath: string;

  try {
    keyFilePath = await createGCPServiceAccountAndKey(projectId, "./key.json");
    logSuccess(`✓ Service account created: external-secrets@${projectId}.iam.gserviceaccount.com`);
    logSuccess(`✓ Service account key created: ${keyFilePath}`);
  } catch (error: any) {
    logError(error.message);
    process.exit(1);
  }

  // Step 6: Create Kubernetes secret (gcpsm-secret)
  log("");
  const secretSpinner = clack.spinner();
  secretSpinner.start("Creating Kubernetes secret (gcpsm-secret)...");

  try {
    const { execSync } = require("child_process");
    const env = kubeconfigPath 
      ? { ...process.env, KUBECONFIG: kubeconfigPath } 
      : process.env;

    execSync(
      `kubectl create secret generic gcpsm-secret ` +
      `--from-file=secret-access-credentials=${keyFilePath} ` +
      `--namespace=external-secrets-system ` +
      `--dry-run=client -o yaml | kubectl apply -f -`,
      { encoding: "utf-8", env }
    );

    secretSpinner.stop("✓ Service account key secret created");
  } catch (error: any) {
    secretSpinner.stop("Failed to create secret");
    logError(error.message);
    process.exit(1);
  }

  // Step 7: Save config to values file (ONLY after secret is created)
  secretSpinner.start("Saving configuration to values/infrastructure/main.yaml...");

  const newConfig: ClusterSecretStoreConfig = {
    name: "gcp-secretstore",
    provider: "gcp",
    projectId,
  };

  try {
    saveClusterSecretStoreConfig(newConfig);
    secretSpinner.stop("✓ Configuration saved");
  } catch (error: any) {
    secretSpinner.stop("Failed to save configuration");
    logError(error.message);
    process.exit(1);
  }

  // Step 8: Show ArgoCD sync instructions
  log("");
  logSuccess("✓ ClusterSecretStore setup complete!");
  log("");
  log("📋 Next steps:");
  log("1. Sync ArgoCD to create ClusterSecretStore:");
  log("   argocd app sync infrastructure");
  log("");
  log("2. Verify ClusterSecretStore is ready:");
  log("   kubectl get clustersecretstore gcp-secretstore");
  log("");
  log("3. Now you can manage secrets:");
  log("   bun scripts/secrets.ts check");
  log("   bun scripts/secrets.ts generate");

  outro("⚙️  Setup complete");
}

/**
 * Generate command - create missing secrets
 */
async function generateCommand() {
  intro("🔐 Generating secrets");

  // Check if ClusterSecretStore is configured (blocking requirement)
  const config = readClusterSecretStoreFromValues();
  if (!config || !config.projectId) {
    logError("ClusterSecretStore not configured in values/infrastructure/main.yaml");
    logInfo("Run setup first: bun scripts/secrets.ts setup");
    process.exit(1);
  }

  const kubeconfigPath = values.kubeconfig as string | undefined;

  // Get project ID with new priority order
  let projectId = (values.project as string) || await detectGCPProjectId(kubeconfigPath);

  if (!projectId) {
    projectId = await promptText({
      message: "GCP Project ID:",
      placeholder: "monobase-prod",
      validate: (value) => (value ? undefined : "Project ID is required"),
    });
  }

  logInfo(`Using GCP project: ${projectId}`);

  // Scan values files
  const spinner = clack.spinner();
  spinner.start("Scanning values files...");

  const results = await scanValuesFiles({
    deployment: values.deployment as string | undefined,
  });

  spinner.stop(`Found ${results.totalSecrets} secrets`);

  if (results.totalSecrets === 0) {
    logWarning("No secrets found");
    outro("🔐 Generate complete");
    return;
  }

  // Initialize provider
  const provider = new SecretProvider(projectId);

  if (!values["dry-run"]) {
    spinner.start("Initializing GCP provider...");
    try {
      await provider.initialize();
      spinner.stop("GCP provider ready");
    } catch (error: any) {
      spinner.stop("Failed to initialize GCP provider");
      logError(error.message);
      process.exit(1);
    }
  }

  // Check which secrets exist
  const remoteKeys = results.secrets.map((s) => s.remoteKey);
  spinner.start(`Checking ${remoteKeys.length} secrets...`);

  const statuses = values["dry-run"]
    ? new Map()
    : await provider.checkSecrets(remoteKeys);

  spinner.stop("Check complete");

  // Find missing secrets
  const missing = results.secrets.filter((s) => {
    const status = statuses.get(s.remoteKey);
    return !status?.exists;
  });

  if (missing.length === 0) {
    logSuccess("All secrets already exist in GCP");
    outro("🔐 Generate complete");
    return;
  }

  logInfo(`Found ${missing.length} missing secrets`);

  // Separate into auto-generate vs manual input
  const autoGenerate = missing.filter((s) => s.generator?.generate);
  const manualInput = missing.filter((s) => !s.generator?.generate);

  if (autoGenerate.length > 0) {
    log(`\n🤖 Auto-generate (${autoGenerate.length}):`);
    for (const secret of autoGenerate) {
      log(`   ${secret.deployment}/${secret.chart}: ${secret.remoteKey}`);
      if (secret.generator) {
        log(`     ${formatSecretDescription(secret.generator)}`);
      }
    }
  }

  if (manualInput.length > 0) {
    log(`\n✍️  Manual input required (${manualInput.length}):`);
    for (const secret of manualInput) {
      log(`   ${secret.deployment}/${secret.chart}: ${secret.remoteKey}`);
    }
  }

  // Confirm before proceeding
  if (!values.yes && !values["dry-run"]) {
    const confirmed = await promptConfirm({
      message: `Create ${missing.length} secrets in GCP?`,
      initialValue: true,
    });

    if (!confirmed) {
      outro("❌ Cancelled");
      return;
    }
  }

  if (values["dry-run"]) {
    logInfo("[DRY RUN] Would create the secrets listed above");
    outro("🔐 Dry run complete");
    return;
  }

  // Generate secrets
  const secretValues = new Map<string, string>();

  // Auto-generate
  for (const secret of autoGenerate) {
    if (secret.generator) {
      const value = generateSecretValue(secret.generator);
      secretValues.set(secret.remoteKey, value);
    }
  }

  // Prompt for manual input
  for (const secret of manualInput) {
    const value = await promptPassword({
      message: `Enter value for ${secret.chart}/${secret.remoteKey}:`,
    });
    secretValues.set(secret.remoteKey, value);
  }

  // Create secrets in GCP
  spinner.start(`Creating ${secretValues.size} secrets...`);

  let created = 0;
  for (const [remoteKey, value] of secretValues.entries()) {
    try {
      await provider.createSecret(remoteKey, value);
      created++;
    } catch (error: any) {
      logError(`Failed to create ${remoteKey}: ${error.message}`);
    }
  }

  spinner.stop(`Created ${created}/${secretValues.size} secrets`);

  outro("🔐 Generate complete");
}

/**
 * Validate command - verify ExternalSecret sync
 */
async function validateCommand() {
  intro("✅ Validating ExternalSecret sync");

  const kubeconfigPath = values.kubeconfig as string | undefined;

  // Scan values files
  const spinner = clack.spinner();
  spinner.start("Scanning values files...");

  const results = await scanValuesFiles({
    deployment: values.deployment as string | undefined,
  });

  spinner.stop(`Found ${results.totalSecrets} secrets`);

  if (results.totalSecrets === 0) {
    logWarning("No secrets found");
    outro("✅ Validation complete");
    return;
  }

  // Validate ExternalSecrets
  spinner.start("Checking ExternalSecret sync status...");

  const validation = await validateExternalSecrets(results.secrets, kubeconfigPath);

  spinner.stop("Validation complete");

  // Display results
  for (const deployment of validation.deployments) {
    log(`\n📦 ${deployment.deployment} (${deployment.namespace}):`);

    for (const externalSecret of deployment.externalSecrets) {
      if (externalSecret.ready) {
        logSuccess(`   ✓ ${externalSecret.name} (synced)`);
      } else if (externalSecret.exists) {
        logWarning(`   ⚠ ${externalSecret.name} (not synced)`);
        if (externalSecret.errorMessage) {
          logError(`     ${externalSecret.errorMessage}`);
        }
      } else {
        logError(`   ✗ ${externalSecret.name} (not found)`);
      }
    }
  }

  log("");
  logInfo(
    `Total: ${validation.readyCount}/${validation.totalExternalSecrets} ready, ` +
      `${validation.errorCount} errors`
  );

  if (validation.success) {
    outro("✅ All ExternalSecrets synced successfully");
  } else {
    outro("❌ Some ExternalSecrets failed to sync");
    process.exit(1);
  }
}

/**
 * Sync command - full workflow
 */
async function syncCommand() {
  intro("🔄 Full secrets sync workflow");

  logInfo("Step 1: Discover secrets");
  await discoverCommand();

  log("");
  logInfo("Step 2: Check GCP Secret Manager");
  await checkCommand();

  log("");
  logInfo("Step 3: Generate missing secrets");
  await generateCommand();

  if (!values["dry-run"]) {
    log("");
    logInfo("Step 4: Validate ExternalSecret sync");
    await validateCommand();
  }

  outro("🔄 Sync workflow complete");
}

// Main execution
async function main() {
  try {
    switch (command) {
      case "discover":
        await discoverCommand();
        break;
      case "check":
        await checkCommand();
        break;
      case "setup":
        await setupCommand();
        break;
      case "generate":
        await generateCommand();
        break;
      case "validate":
        await validateCommand();
        break;
      case "sync":
        await syncCommand();
        break;
      default:
        logError(`Unknown command: ${command}`);
        logInfo("Run with --help for usage information");
        process.exit(1);
    }
  } catch (error: any) {
    logError(error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
