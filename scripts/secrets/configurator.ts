/**
 * Configurator Module
 * Setup and validate ClusterSecretStore configuration
 */

import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { execSync } from "child_process";

/**
 * ClusterSecretStore provider configuration
 */
export interface ClusterSecretStoreConfig {
  name: string;
  provider: "gcp" | "aws" | "azure";
  projectId?: string; // GCP
  region?: string; // AWS/GCP
  accountId?: string; // AWS
  tenantId?: string; // Azure
}

/**
 * ClusterSecretStore status
 */
export interface ClusterSecretStoreStatus {
  exists: boolean;
  configured: boolean;
  provider?: string;
  ready?: boolean;
  errorMessage?: string;
}

/**
 * Read ClusterSecretStore configuration from values
 */
export function readClusterSecretStoreFromValues(): ClusterSecretStoreConfig | undefined {
  try {
    const valuesPath = "values/infrastructure/main.yaml";
    
    if (!existsSync(valuesPath)) {
      return undefined;
    }
    
    const content = readFileSync(valuesPath, "utf-8");
    const values = parseYaml(content);
    
    const stores = values?.externalSecrets?.stores;
    
    if (!stores || !Array.isArray(stores) || stores.length === 0) {
      return undefined;
    }
    
    // Use first store as primary
    const store = stores[0];
    
    if (!store.name || !store.provider) {
      return undefined;
    }
    
    const config: ClusterSecretStoreConfig = {
      name: store.name,
      provider: store.provider,
    };
    
    // Add provider-specific configuration
    if (store.provider === "gcp" && store.gcp) {
      config.projectId = store.gcp.projectId;
    } else if (store.provider === "aws" && store.aws) {
      config.region = store.aws.region;
      config.accountId = store.aws.accountId;
    } else if (store.provider === "azure" && store.azure) {
      config.tenantId = store.azure.tenantId;
    }
    
    return config;
  } catch (error) {
    return undefined;
  }
}

/**
 * Check if ClusterSecretStore exists in the cluster
 */
export async function checkClusterSecretStoreStatus(
  name: string,
  kubeconfigPath?: string
): Promise<ClusterSecretStoreStatus> {
  try {
    const env = kubeconfigPath 
      ? { ...process.env, KUBECONFIG: kubeconfigPath } 
      : process.env;
    
    // Check if ClusterSecretStore exists
    const getCommand = `kubectl get clustersecretstore ${name} -o json 2>/dev/null`;
    
    try {
      const output = execSync(getCommand, {
        encoding: "utf-8",
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      
      const store = JSON.parse(output);
      
      // Extract status information
      const provider = store.spec?.provider ? Object.keys(store.spec.provider)[0] : undefined;
      const conditions = store.status?.conditions || [];
      
      // Check if Ready condition is True
      const readyCondition = conditions.find((c: any) => c.type === "Ready");
      const ready = readyCondition?.status === "True";
      const errorMessage = readyCondition?.message;
      
      return {
        exists: true,
        configured: true,
        provider,
        ready,
        errorMessage: ready ? undefined : errorMessage,
      };
    } catch (error) {
      // ClusterSecretStore doesn't exist
      return {
        exists: false,
        configured: false,
      };
    }
  } catch (error: any) {
    return {
      exists: false,
      configured: false,
      errorMessage: error.message,
    };
  }
}

/**
 * Read GCP project ID from actual ClusterSecretStore in cluster
 */
export async function readProjectIdFromCluster(
  storeName: string,
  kubeconfigPath?: string
): Promise<string | undefined> {
  try {
    const env = kubeconfigPath 
      ? { ...process.env, KUBECONFIG: kubeconfigPath } 
      : process.env;
    
    const getCommand = `kubectl get clustersecretstore ${storeName} -o json 2>/dev/null`;
    
    const output = execSync(getCommand, {
      encoding: "utf-8",
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    
    const store = JSON.parse(output);
    const projectId = store.spec?.provider?.gcpsm?.projectID;
    
    return projectId || undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Save ClusterSecretStore configuration to values file
 * Only call this after service account key secret is created
 */
export function saveClusterSecretStoreConfig(
  config: ClusterSecretStoreConfig,
  valuesPath: string = "values/infrastructure/main.yaml"
): void {
  try {
    if (!existsSync(valuesPath)) {
      throw new Error(`Values file not found: ${valuesPath}`);
    }
    
    const content = readFileSync(valuesPath, "utf-8");
    const values = parseYaml(content);
    
    // Ensure structure exists
    if (!values.externalSecrets) {
      values.externalSecrets = {};
    }
    if (!values.externalSecrets.stores) {
      values.externalSecrets.stores = [];
    }
    
    // Update first store (single-store architecture)
    if (values.externalSecrets.stores.length === 0) {
      // Create new store entry
      values.externalSecrets.stores.push({
        name: config.name,
        provider: config.provider,
      });
    }
    
    const store = values.externalSecrets.stores[0];
    
    // Update provider-specific config
    if (config.provider === "gcp") {
      if (!store.gcp) {
        store.gcp = {};
      }
      store.gcp.projectId = config.projectId;
    } else if (config.provider === "aws") {
      if (!store.aws) {
        store.aws = {};
      }
      store.aws.region = config.region;
      store.aws.accountId = config.accountId;
    } else if (config.provider === "azure") {
      if (!store.azure) {
        store.azure = {};
      }
      store.azure.tenantId = config.tenantId;
    }
    
    // Write back to file using simple string replacement
    // This preserves comments and formatting
    const lines = content.split("\n");
    let updated = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Find the projectId line in the GCP section
      if (config.provider === "gcp" && line.includes("projectId:")) {
        // Check if we're in the right context (after gcp:)
        let foundGcpSection = false;
        for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
          if (lines[j].trim() === "gcp:") {
            foundGcpSection = true;
            break;
          }
        }
        
        if (foundGcpSection) {
          const indent = line.match(/^\s*/)?.[0] || "        ";
          lines[i] = `${indent}projectId: "${config.projectId}"  # Auto-populated by setup script`;
          updated = true;
          break;
        }
      }
    }
    
    if (!updated) {
      throw new Error("Failed to update projectId in values file");
    }
    
    // Write back to file
    const { writeFileSync } = require("fs");
    writeFileSync(valuesPath, lines.join("\n"), "utf-8");
  } catch (error: any) {
    throw new Error(`Failed to save ClusterSecretStore config: ${error.message}`);
  }
}

/**
 * Validate ClusterSecretStore configuration
 */
export function validateClusterSecretStoreConfig(
  config: ClusterSecretStoreConfig
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!config.name) {
    errors.push("ClusterSecretStore name is required");
  }
  
  if (!config.provider) {
    errors.push("Provider is required");
  }
  
  // Provider-specific validation
  if (config.provider === "gcp") {
    if (!config.projectId) {
      errors.push("GCP projectId is required");
    }
  } else if (config.provider === "aws") {
    if (!config.region) {
      errors.push("AWS region is required");
    }
    if (!config.accountId) {
      errors.push("AWS accountId is required");
    }
  } else if (config.provider === "azure") {
    if (!config.tenantId) {
      errors.push("Azure tenantId is required");
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Check if External Secrets Operator is installed
 */
export async function checkExternalSecretsOperator(
  kubeconfigPath?: string
): Promise<{ installed: boolean; version?: string; ready?: boolean }> {
  try {
    const env = kubeconfigPath 
      ? { ...process.env, KUBECONFIG: kubeconfigPath } 
      : process.env;
    
    // Check if external-secrets namespace exists
    const namespaceCommand = `kubectl get namespace external-secrets-system -o json 2>/dev/null`;
    
    try {
      execSync(namespaceCommand, {
        encoding: "utf-8",
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (error) {
      return { installed: false };
    }
    
    // Check if external-secrets deployment is ready
    const deploymentCommand = `kubectl get deployment -n external-secrets-system external-secrets -o json 2>/dev/null`;
    
    try {
      const output = execSync(deploymentCommand, {
        encoding: "utf-8",
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      
      const deployment = JSON.parse(output);
      const ready = deployment.status?.readyReplicas > 0;
      
      // Try to get version from image tag
      const image = deployment.spec?.template?.spec?.containers?.[0]?.image;
      const version = image ? image.split(":")[1] : undefined;
      
      return {
        installed: true,
        version,
        ready,
      };
    } catch (error) {
      return { installed: false };
    }
  } catch (error) {
    return { installed: false };
  }
}

/**
 * Get recommended ClusterSecretStore name based on provider
 */
export function getDefaultClusterSecretStoreName(provider: string): string {
  return `${provider}-secretstore`;
}

/**
 * Check if service account key secret exists (for GCP)
 */
export async function checkServiceAccountKeySecret(
  kubeconfigPath?: string
): Promise<boolean> {
  try {
    const env = kubeconfigPath 
      ? { ...process.env, KUBECONFIG: kubeconfigPath } 
      : process.env;
    
    const command = `kubectl get secret gcpsm-secret -n external-secrets-system 2>/dev/null`;
    
    execSync(command, {
      encoding: "utf-8",
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Generate instructions for manual ClusterSecretStore setup
 */
export function generateSetupInstructions(
  config: ClusterSecretStoreConfig
): string[] {
  const instructions: string[] = [];
  
  if (config.provider === "gcp") {
    instructions.push(
      "GCP ClusterSecretStore Setup:",
      "",
      "1. Create service account:",
      `   gcloud iam service-accounts create external-secrets \\`,
      `     --project=${config.projectId}`,
      "",
      "2. Grant Secret Manager permissions:",
      `   gcloud projects add-iam-policy-binding ${config.projectId} \\`,
      `     --member="serviceAccount:external-secrets@${config.projectId}.iam.gserviceaccount.com" \\`,
      `     --role="roles/secretmanager.secretAccessor"`,
      "",
      "3. Create and download service account key:",
      `   gcloud iam service-accounts keys create key.json \\`,
      `     --iam-account=external-secrets@${config.projectId}.iam.gserviceaccount.com`,
      "",
      "4. Create Kubernetes secret:",
      `   kubectl create secret generic gcpsm-secret \\`,
      `     --from-file=secret-access-credentials=key.json \\`,
      `     --namespace=external-secrets-system`,
      "",
      "5. ClusterSecretStore is managed by ArgoCD:",
      `   File: argocd/infrastructure/templates/external-secrets-stores.yaml`,
      `   Config: values/infrastructure/main.yaml (externalSecrets.stores)`
    );
  } else if (config.provider === "aws") {
    instructions.push(
      "AWS ClusterSecretStore Setup:",
      "",
      "1. Create IAM user or role for External Secrets Operator",
      "2. Attach policy for Secrets Manager access",
      "3. Create access key credentials",
      "4. Create Kubernetes secret with AWS credentials",
      "5. Configure ClusterSecretStore in values/infrastructure/main.yaml"
    );
  } else if (config.provider === "azure") {
    instructions.push(
      "Azure ClusterSecretStore Setup:",
      "",
      "1. Create Azure AD application",
      "2. Grant Key Vault permissions",
      "3. Create client secret",
      "4. Create Kubernetes secret with Azure credentials",
      "5. Configure ClusterSecretStore in values/infrastructure/main.yaml"
    );
  }
  
  return instructions;
}

/**
 * Check if gcloud CLI is installed and user is authenticated
 */
export async function checkGCloudReady(): Promise<{
  installed: boolean;
  authenticated: boolean;
  activeAccount?: string;
}> {
  try {
    // Check if gcloud is installed
    try {
      execSync("gcloud --version", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (error) {
      return { installed: false, authenticated: false };
    }

    // Check if user is authenticated
    try {
      const output = execSync("gcloud auth list --filter=status:ACTIVE --format='value(account)'", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();

      if (!output) {
        return { installed: true, authenticated: false };
      }

      return {
        installed: true,
        authenticated: true,
        activeAccount: output,
      };
    } catch (error) {
      return { installed: true, authenticated: false };
    }
  } catch (error) {
    return { installed: false, authenticated: false };
  }
}

/**
 * List available GCP projects for the authenticated user
 */
export async function listGCPProjects(): Promise<string[]> {
  try {
    const output = execSync(
      "gcloud projects list --format='value(projectId)' --sort-by=projectId",
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }
    );
    
    const projects = output.trim().split("\n").filter(Boolean);
    return projects;
  } catch (error) {
    return [];
  }
}

/**
 * Create GCP service account and download key automatically
 */
export async function createGCPServiceAccountAndKey(
  projectId: string,
  outputPath: string = "./key.json"
): Promise<string> {
  const serviceAccountName = "external-secrets";
  const serviceAccountEmail = `${serviceAccountName}@${projectId}.iam.gserviceaccount.com`;

  try {
    // Step 1: Create service account (handle already-exists error)
    try {
      execSync(
        `gcloud iam service-accounts create ${serviceAccountName} --project=${projectId}`,
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    } catch (error: any) {
      // Check if error is because service account already exists
      if (error.message.includes("already exists") || error.message.includes("ALREADY_EXISTS")) {
        // Service account exists, continue
      } else {
        throw new Error(`Failed to create service account: ${error.message}`);
      }
    }

    // Step 2: Grant Secret Manager permissions
    try {
      execSync(
        `gcloud projects add-iam-policy-binding ${projectId} ` +
        `--member="serviceAccount:${serviceAccountEmail}" ` +
        `--role="roles/secretmanager.secretAccessor" ` +
        `--condition=None`,
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    } catch (error: any) {
      // If binding already exists, that's fine
      if (!error.message.includes("already has") && !error.message.includes("ALREADY_EXISTS")) {
        throw new Error(`Failed to grant permissions: ${error.message}`);
      }
    }

    // Step 3: Create and download service account key
    execSync(
      `gcloud iam service-accounts keys create ${outputPath} ` +
      `--iam-account=${serviceAccountEmail}`,
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    return outputPath;
  } catch (error: any) {
    throw new Error(`GCP service account setup failed: ${error.message}`);
  }
}
