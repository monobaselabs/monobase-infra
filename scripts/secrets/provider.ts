/**
 * Provider Module - GCP Secret Manager Operations
 * Simplified provider for values-driven secret management
 */

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import type { DiscoveredSecret } from "./scanner";

/**
 * Secret status in provider
 */
export interface SecretStatus {
  remoteKey: string;
  exists: boolean;
  lastUpdated?: Date;
  versionCount?: number;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  projectId: string;
  provider: "gcp" | "aws" | "azure";
}

/**
 * GCP Secret Manager Provider
 */
export class SecretProvider {
  private client: SecretManagerServiceClient;
  private projectId: string;
  
  constructor(projectId: string) {
    this.projectId = projectId;
    this.client = new SecretManagerServiceClient();
  }
  
  /**
   * Initialize and test authentication
   */
  async initialize(): Promise<void> {
    try {
      const parent = `projects/${this.projectId}`;
      await this.client.listSecrets(
        { parent, pageSize: 1 },
        { autoPaginate: false }
      );
    } catch (error: any) {
      if (error.code === 7) {
        // PERMISSION_DENIED
        throw new Error(
          `Permission denied accessing project ${this.projectId}.\n` +
          `Make sure you're authenticated: gcloud auth application-default login\n` +
          `And Secret Manager API is enabled.`
        );
      }
      throw error;
    }
  }
  
  /**
   * Check if a secret exists
   */
  async secretExists(remoteKey: string): Promise<boolean> {
    try {
      const name = `projects/${this.projectId}/secrets/${remoteKey}`;
      await this.client.getSecret({ name });
      return true;
    } catch (error: any) {
      if (error.code === 5) {
        // NOT_FOUND
        return false;
      }
      throw error;
    }
  }
  
  /**
   * Get detailed status of a secret
   */
  async getSecretStatus(remoteKey: string): Promise<SecretStatus> {
    try {
      const name = `projects/${this.projectId}/secrets/${remoteKey}`;
      const [secret] = await this.client.getSecret({ name });
      
      // List versions to get count and last updated
      const [versions] = await this.client.listSecretVersions(
        { parent: name, pageSize: 1 },
        { autoPaginate: false }
      );
      
      const lastVersion = versions[0];
      const lastUpdated = lastVersion?.createTime
        ? new Date(lastVersion.createTime.seconds! * 1000)
        : undefined;
      
      return {
        remoteKey,
        exists: true,
        lastUpdated,
        versionCount: versions.length,
      };
    } catch (error: any) {
      if (error.code === 5) {
        // NOT_FOUND
        return {
          remoteKey,
          exists: false,
        };
      }
      throw error;
    }
  }
  
  /**
   * Check status of multiple secrets in parallel
   */
  async checkSecrets(remoteKeys: string[]): Promise<Map<string, SecretStatus>> {
    const results = new Map<string, SecretStatus>();
    
    // Check in parallel with concurrency limit
    const CONCURRENCY = 10;
    for (let i = 0; i < remoteKeys.length; i += CONCURRENCY) {
      const batch = remoteKeys.slice(i, i + CONCURRENCY);
      const statuses = await Promise.all(
        batch.map((key) => this.getSecretStatus(key))
      );
      
      for (const status of statuses) {
        results.set(status.remoteKey, status);
      }
    }
    
    return results;
  }
  
  /**
   * Create a new secret
   */
  async createSecret(remoteKey: string, value: string): Promise<void> {
    const parent = `projects/${this.projectId}`;
    const secretId = remoteKey;
    
    // Create new secret
    const [secret] = await this.client.createSecret({
      parent,
      secretId,
      secret: {
        replication: {
          automatic: {},
        },
      },
    });
    
    // Add first version
    await this.client.addSecretVersion({
      parent: secret.name!,
      payload: {
        data: Buffer.from(value, "utf8"),
      },
    });
  }
  
  /**
   * Update an existing secret (add new version)
   */
  async updateSecret(remoteKey: string, value: string): Promise<void> {
    const secretName = `projects/${this.projectId}/secrets/${remoteKey}`;
    
    await this.client.addSecretVersion({
      parent: secretName,
      payload: {
        data: Buffer.from(value, "utf8"),
      },
    });
  }
  
  /**
   * Create or update a secret
   */
  async upsertSecret(remoteKey: string, value: string): Promise<{ created: boolean }> {
    const exists = await this.secretExists(remoteKey);
    
    if (exists) {
      await this.updateSecret(remoteKey, value);
      return { created: false };
    } else {
      await this.createSecret(remoteKey, value);
      return { created: true };
    }
  }
  
  /**
   * Delete a secret
   */
  async deleteSecret(remoteKey: string): Promise<void> {
    const name = `projects/${this.projectId}/secrets/${remoteKey}`;
    await this.client.deleteSecret({ name });
  }
  
  /**
   * List all secrets in the project
   */
  async listSecrets(): Promise<string[]> {
    const parent = `projects/${this.projectId}`;
    const secretNames: string[] = [];
    
    const [secrets] = await this.client.listSecrets({ parent }, { autoPaginate: false });
    
    for (const secret of secrets) {
      if (secret.name) {
        // Extract secret ID from full name (projects/PROJECT/secrets/SECRET_ID)
        const parts = secret.name.split("/");
        const secretId = parts[parts.length - 1];
        secretNames.push(secretId);
      }
    }
    
    return secretNames;
  }
  
  /**
   * Get the GCP project ID
   */
  getProjectId(): string {
    return this.projectId;
  }
}

/**
 * Auto-detect GCP project ID from various sources
 * Priority: CLI flag → Cluster → Values file → gcloud config
 * Note: CLI flag is handled by caller, prompt is also handled by caller
 */
export async function detectGCPProjectId(
  kubeconfigPath?: string
): Promise<string | undefined> {
  // 1. Read from actual ClusterSecretStore in cluster
  try {
    const { readProjectIdFromCluster } = await import("./configurator");
    const clusterProjectId = await readProjectIdFromCluster("gcp-secretstore", kubeconfigPath);
    if (clusterProjectId) {
      return clusterProjectId;
    }
  } catch (error) {
    // Cluster not accessible or ClusterSecretStore doesn't exist
  }
  
  // 2. Read from values file
  const valuesProjectId = readProjectIdFromValues();
  if (valuesProjectId) {
    return valuesProjectId;
  }
  
  // 3. gcloud config
  try {
    const { execSync } = await import("child_process");
    const projectId = execSync("gcloud config get-value project 2>/dev/null", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    
    return projectId || undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Read GCP project ID from infrastructure values
 */
export function readProjectIdFromValues(): string | undefined {
  try {
    const { readFileSync } = require("fs");
    const { parse } = require("yaml");
    
    const valuesPath = "values/infrastructure/main.yaml";
    const content = readFileSync(valuesPath, "utf-8");
    const values = parse(content);
    
    const projectId = values?.externalSecrets?.stores?.[0]?.gcp?.projectId;
    
    if (projectId && typeof projectId === "string" && !projectId.includes("{{")) {
      return projectId;
    }
  } catch (error) {
    // Ignore errors
  }
  
  return undefined;
}
