/**
 * Validator Module
 * Verify ExternalSecret sync and Kubernetes secret creation
 */

import { execSync } from "child_process";
import type { DiscoveredSecret } from "./scanner";

/**
 * ExternalSecret sync status
 */
export interface ExternalSecretStatus {
  name: string;
  namespace: string;
  exists: boolean;
  synced: boolean;
  ready: boolean;
  secretCreated: boolean;
  lastSyncTime?: Date;
  errorMessage?: string;
  conditions?: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;
}

/**
 * Validation result for a deployment
 */
export interface DeploymentValidationResult {
  deployment: string;
  namespace: string;
  externalSecrets: ExternalSecretStatus[];
  allSynced: boolean;
  allReady: boolean;
  errorCount: number;
}

/**
 * Overall validation result
 */
export interface ValidationResult {
  success: boolean;
  deployments: DeploymentValidationResult[];
  totalExternalSecrets: number;
  syncedCount: number;
  readyCount: number;
  errorCount: number;
}

/**
 * Get ExternalSecret status from cluster
 */
export async function getExternalSecretStatus(
  name: string,
  namespace: string,
  kubeconfigPath?: string
): Promise<ExternalSecretStatus> {
  try {
    const env = kubeconfigPath 
      ? { ...process.env, KUBECONFIG: kubeconfigPath } 
      : process.env;
    
    // Get ExternalSecret
    const getCommand = `kubectl get externalsecret ${name} -n ${namespace} -o json 2>/dev/null`;
    
    try {
      const output = execSync(getCommand, {
        encoding: "utf-8",
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      
      const externalSecret = JSON.parse(output);
      
      // Extract status
      const status = externalSecret.status || {};
      const conditions = status.conditions || [];
      
      // Check Ready condition
      const readyCondition = conditions.find((c: any) => c.type === "Ready");
      const ready = readyCondition?.status === "True";
      
      // Check SecretSynced condition
      const syncedCondition = conditions.find((c: any) => c.type === "SecretSynced");
      const synced = syncedCondition?.status === "True";
      
      // Get last sync time
      const lastSyncTime = status.syncedTime 
        ? new Date(status.syncedTime) 
        : undefined;
      
      // Check if target secret was created
      const secretCreated = status.binding?.name ? true : false;
      
      // Get error message
      let errorMessage: string | undefined;
      if (!ready && readyCondition?.message) {
        errorMessage = readyCondition.message;
      } else if (!synced && syncedCondition?.message) {
        errorMessage = syncedCondition.message;
      }
      
      return {
        name,
        namespace,
        exists: true,
        synced,
        ready,
        secretCreated,
        lastSyncTime,
        errorMessage,
        conditions: conditions.map((c: any) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
      };
    } catch (error) {
      // ExternalSecret doesn't exist
      return {
        name,
        namespace,
        exists: false,
        synced: false,
        ready: false,
        secretCreated: false,
        errorMessage: "ExternalSecret not found",
      };
    }
  } catch (error: any) {
    return {
      name,
      namespace,
      exists: false,
      synced: false,
      ready: false,
      secretCreated: false,
      errorMessage: error.message,
    };
  }
}

/**
 * Check if a Kubernetes secret exists
 */
export async function checkKubernetesSecret(
  name: string,
  namespace: string,
  kubeconfigPath?: string
): Promise<boolean> {
  try {
    const env = kubeconfigPath 
      ? { ...process.env, KUBECONFIG: kubeconfigPath } 
      : process.env;
    
    const command = `kubectl get secret ${name} -n ${namespace} 2>/dev/null`;
    
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
 * List all ExternalSecrets in a namespace
 */
export async function listExternalSecretsInNamespace(
  namespace: string,
  kubeconfigPath?: string
): Promise<string[]> {
  try {
    const env = kubeconfigPath 
      ? { ...process.env, KUBECONFIG: kubeconfigPath } 
      : process.env;
    
    const command = `kubectl get externalsecret -n ${namespace} -o json 2>/dev/null`;
    
    try {
      const output = execSync(command, {
        encoding: "utf-8",
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      
      const list = JSON.parse(output);
      const names = list.items?.map((item: any) => item.metadata?.name).filter(Boolean) || [];
      
      return names;
    } catch (error) {
      return [];
    }
  } catch (error) {
    return [];
  }
}

/**
 * Validate all ExternalSecrets for discovered secrets
 */
export async function validateExternalSecrets(
  secrets: DiscoveredSecret[],
  kubeconfigPath?: string
): Promise<ValidationResult> {
  const deploymentResults = new Map<string, DeploymentValidationResult>();
  
  // Group secrets by deployment and namespace
  const grouped = new Map<string, DiscoveredSecret[]>();
  for (const secret of secrets) {
    const key = `${secret.deployment}:${secret.namespace || "default"}`;
    const existing = grouped.get(key) || [];
    existing.push(secret);
    grouped.set(key, existing);
  }
  
  // Validate each group
  for (const [key, secretGroup] of grouped.entries()) {
    const [deployment, namespace] = key.split(":");
    const externalSecretStatuses: ExternalSecretStatus[] = [];
    
    for (const secret of secretGroup) {
      // Derive ExternalSecret name from chart and deployment
      // This should match the naming in chart templates
      const externalSecretName = `${secret.chart}-credentials`;
      
      const status = await getExternalSecretStatus(
        externalSecretName,
        namespace,
        kubeconfigPath
      );
      
      externalSecretStatuses.push(status);
    }
    
    const allSynced = externalSecretStatuses.every(s => s.synced);
    const allReady = externalSecretStatuses.every(s => s.ready);
    const errorCount = externalSecretStatuses.filter(s => !s.ready).length;
    
    deploymentResults.set(deployment, {
      deployment,
      namespace,
      externalSecrets: externalSecretStatuses,
      allSynced,
      allReady,
      errorCount,
    });
  }
  
  // Calculate overall statistics
  const deployments = Array.from(deploymentResults.values());
  const totalExternalSecrets = deployments.reduce(
    (sum, d) => sum + d.externalSecrets.length,
    0
  );
  const syncedCount = deployments.reduce(
    (sum, d) => sum + d.externalSecrets.filter(e => e.synced).length,
    0
  );
  const readyCount = deployments.reduce(
    (sum, d) => sum + d.externalSecrets.filter(e => e.ready).length,
    0
  );
  const errorCount = deployments.reduce(
    (sum, d) => sum + d.errorCount,
    0
  );
  
  return {
    success: errorCount === 0 && syncedCount === totalExternalSecrets,
    deployments,
    totalExternalSecrets,
    syncedCount,
    readyCount,
    errorCount,
  };
}

/**
 * Get detailed sync status for a specific deployment
 */
export async function getDeploymentSyncStatus(
  deployment: string,
  namespace: string,
  kubeconfigPath?: string
): Promise<DeploymentValidationResult | undefined> {
  const externalSecretNames = await listExternalSecretsInNamespace(
    namespace,
    kubeconfigPath
  );
  
  if (externalSecretNames.length === 0) {
    return undefined;
  }
  
  const externalSecrets: ExternalSecretStatus[] = [];
  
  for (const name of externalSecretNames) {
    const status = await getExternalSecretStatus(
      name,
      namespace,
      kubeconfigPath
    );
    externalSecrets.push(status);
  }
  
  const allSynced = externalSecrets.every(s => s.synced);
  const allReady = externalSecrets.every(s => s.ready);
  const errorCount = externalSecrets.filter(s => !s.ready).length;
  
  return {
    deployment,
    namespace,
    externalSecrets,
    allSynced,
    allReady,
    errorCount,
  };
}

/**
 * Wait for ExternalSecret to sync (with timeout)
 */
export async function waitForExternalSecretSync(
  name: string,
  namespace: string,
  kubeconfigPath?: string,
  timeoutMs: number = 60000
): Promise<{ synced: boolean; ready: boolean; error?: string }> {
  const startTime = Date.now();
  const pollInterval = 2000; // 2 seconds
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await getExternalSecretStatus(name, namespace, kubeconfigPath);
    
    if (status.ready && status.synced) {
      return { synced: true, ready: true };
    }
    
    if (status.errorMessage) {
      return { 
        synced: false, 
        ready: false, 
        error: status.errorMessage 
      };
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  return { 
    synced: false, 
    ready: false, 
    error: "Timeout waiting for ExternalSecret to sync" 
  };
}
