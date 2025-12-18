/**
 * Values Scanner Module
 * Scans values files for externalSecrets configuration
 */

import { glob } from "glob";
import { readFileSync } from "fs";
import { resolve, basename, dirname } from "path";
import { parse as parseYaml } from "yaml";

/**
 * Secret generator metadata
 */
export interface SecretGenerator {
  generate: boolean;
  type: "password" | "key" | "token" | "string";
  length?: number;
  description?: string;
}

/**
 * Single secret configuration (Pattern 1)
 */
export interface SingleSecretConfig {
  enabled: boolean;
  remoteKey: string;
  generator?: SecretGenerator;
  secretStore?: string;
  refreshInterval?: string;
}

/**
 * Array secret item (Pattern 2)
 */
export interface SecretItem {
  remoteKey: string;
  generator?: SecretGenerator;
}

/**
 * Array secrets configuration (Pattern 2)
 */
export interface ArraySecretsConfig {
  enabled: boolean;
  secrets: SecretItem[];
  secretStore?: string;
  refreshInterval?: string;
}

/**
 * Discovered secret from values files
 */
export interface DiscoveredSecret {
  // Source information
  sourceFile: string;
  deployment: string;
  chart: string;
  environment?: string; // production, staging, etc.
  
  // Secret details
  remoteKey: string;
  generator?: SecretGenerator;
  
  // Context
  secretStore: string;
  refreshInterval: string;
  namespace?: string;
}

/**
 * Scanner results
 */
export interface ScanResults {
  secrets: DiscoveredSecret[];
  deploymentFiles: string[];
  infrastructureFiles: string[];
  totalSecrets: number;
  secretsWithGenerator: number;
}

/**
 * Check if value is a single secret config (Pattern 1)
 */
function isSingleSecretConfig(value: any): value is SingleSecretConfig {
  return (
    value &&
    typeof value === "object" &&
    typeof value.enabled === "boolean" &&
    typeof value.remoteKey === "string"
  );
}

/**
 * Check if value is an array secrets config (Pattern 2)
 */
function isArraySecretsConfig(value: any): value is ArraySecretsConfig {
  return (
    value &&
    typeof value === "object" &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.secrets) &&
    value.secrets.length > 0
  );
}

/**
 * Extract secrets from a chart configuration
 */
function extractSecretsFromChart(
  chartName: string,
  chartConfig: any,
  sourceFile: string,
  deployment: string,
  environment?: string
): DiscoveredSecret[] {
  const secrets: DiscoveredSecret[] = [];
  
  // Look for externalSecrets key
  const externalSecrets = chartConfig?.externalSecrets;
  
  if (!externalSecrets || !externalSecrets.enabled) {
    return secrets;
  }
  
  const secretStore = externalSecrets.secretStore || "gcp-secretstore";
  const refreshInterval = externalSecrets.refreshInterval || "1h";
  const namespace = chartConfig?.namespace;
  
  // Pattern 1: Single secret (postgresql, external-dns)
  if (isSingleSecretConfig(externalSecrets)) {
    secrets.push({
      sourceFile,
      deployment,
      chart: chartName,
      environment,
      remoteKey: externalSecrets.remoteKey,
      generator: externalSecrets.generator,
      secretStore,
      refreshInterval,
      namespace,
    });
  }
  // Pattern 2: Array of secrets (minio, api, frontends)
  else if (isArraySecretsConfig(externalSecrets)) {
    for (const secretItem of externalSecrets.secrets) {
      secrets.push({
        sourceFile,
        deployment,
        chart: chartName,
        environment,
        remoteKey: secretItem.remoteKey,
        generator: secretItem.generator,
        secretStore,
        refreshInterval,
        namespace,
      });
    }
  }
  
  return secrets;
}

/**
 * Parse a values file and extract all secrets
 */
function parseValuesFile(filePath: string): DiscoveredSecret[] {
  const secrets: DiscoveredSecret[] = [];
  
  try {
    const content = readFileSync(filePath, "utf-8");
    const values = parseYaml(content);
    
    if (!values || typeof values !== "object") {
      return secrets;
    }
    
    // Determine deployment name and environment from file path
    const fileName = basename(filePath, ".yaml");
    let deployment = fileName;
    let environment: string | undefined;
    
    // Extract environment from deployment name (e.g., "acme-staging" -> "staging")
    const parts = fileName.split("-");
    if (parts.length > 1) {
      const lastPart = parts[parts.length - 1];
      if (["staging", "production", "development", "dev", "stg", "prod"].includes(lastPart)) {
        environment = lastPart;
      }
    }
    
    // Check if this is an infrastructure file
    const isInfrastructure = filePath.includes("/infrastructure/");
    if (isInfrastructure) {
      deployment = "infrastructure";
    }

    // For infrastructure files, also check root-level externalSecrets
    // (file represents a single chart's values, like external-dns.yaml)
    if (isInfrastructure && values.externalSecrets) {
      const chartSecrets = extractSecretsFromChart(
        fileName,  // Use filename as chart name (e.g., "external-dns")
        values,    // Root values contain externalSecrets
        filePath,
        deployment,
        environment
      );
      secrets.push(...chartSecrets);
    }

    // Iterate over top-level keys (chart names)
    for (const [chartName, chartConfig] of Object.entries(values)) {
      // Skip global and other non-chart keys
      if (chartName === "global" || chartName === "argocd") {
        continue;
      }
      
      const chartSecrets = extractSecretsFromChart(
        chartName,
        chartConfig,
        filePath,
        deployment,
        environment
      );
      
      secrets.push(...chartSecrets);
    }
  } catch (error) {
    // Ignore parsing errors, return empty array
  }
  
  return secrets;
}

/**
 * Scan all values files for externalSecrets configuration
 * 
 * @param options.deployment - Optional filter for specific deployment
 * @returns Scan results with discovered secrets
 */
export async function scanValuesFiles(options?: {
  deployment?: string;
}): Promise<ScanResults> {
  const patterns = [
    "values/deployments/*.yaml",
    "values/infrastructure/*.yaml",
  ];
  
  // Find all values files
  const allFiles: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { cwd: process.cwd() });
    allFiles.push(...matches.map((f) => resolve(f)));
  }
  
  // Filter by deployment if specified
  const files = options?.deployment
    ? allFiles.filter((f) => basename(f, ".yaml") === options.deployment)
    : allFiles;
  
  // Parse all files and collect secrets
  const allSecrets: DiscoveredSecret[] = [];
  for (const file of files) {
    const secrets = parseValuesFile(file);
    allSecrets.push(...secrets);
  }
  
  // Categorize files
  const deploymentFiles = files.filter((f) => f.includes("/deployments/"));
  const infrastructureFiles = files.filter((f) => f.includes("/infrastructure/"));
  
  // Statistics
  const secretsWithGenerator = allSecrets.filter((s) => s.generator?.generate).length;
  
  return {
    secrets: allSecrets,
    deploymentFiles,
    infrastructureFiles,
    totalSecrets: allSecrets.length,
    secretsWithGenerator,
  };
}

/**
 * Group secrets by deployment
 */
export function groupByDeployment(secrets: DiscoveredSecret[]): Map<string, DiscoveredSecret[]> {
  const grouped = new Map<string, DiscoveredSecret[]>();
  
  for (const secret of secrets) {
    const existing = grouped.get(secret.deployment) || [];
    existing.push(secret);
    grouped.set(secret.deployment, existing);
  }
  
  return grouped;
}

/**
 * Group secrets by chart
 */
export function groupByChart(secrets: DiscoveredSecret[]): Map<string, DiscoveredSecret[]> {
  const grouped = new Map<string, DiscoveredSecret[]>();
  
  for (const secret of secrets) {
    const existing = grouped.get(secret.chart) || [];
    existing.push(secret);
    grouped.set(secret.chart, existing);
  }
  
  return grouped;
}

/**
 * Filter secrets that need generation
 */
export function filterGeneratable(secrets: DiscoveredSecret[]): DiscoveredSecret[] {
  return secrets.filter((s) => s.generator?.generate === true);
}

/**
 * Filter secrets by environment
 */
export function filterByEnvironment(
  secrets: DiscoveredSecret[],
  environment: string
): DiscoveredSecret[] {
  return secrets.filter((s) => s.environment === environment);
}
