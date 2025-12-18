# Secrets Management - Values-Driven Architecture

Modern secrets management system that automatically discovers secrets from values files and manages them in GCP Secret Manager.

## Architecture Overview

The new architecture follows these principles:

1. **Values-Driven**: Secrets are defined in `values/` files, not in separate `secrets.yaml` files
2. **Chart-Based**: Each chart manages its own ExternalSecret templates
3. **Auto-Discovery**: The CLI scans values files to discover what secrets are needed
4. **Auto-Generation**: Secrets can be automatically generated based on type (password, key, token)
5. **GitOps-Ready**: ClusterSecretStore managed by ArgoCD from values configuration

## File Structure

```
scripts/
├── secrets-v2.ts           # Modern CLI (new)
├── secrets.ts              # Legacy CLI (old, deprecated)
└── secrets/
    ├── scanner.ts          # Scan values files for externalSecrets
    ├── provider.ts         # GCP Secret Manager operations
    ├── generator.ts        # Auto-generate passwords/keys/tokens
    ├── configurator.ts     # ClusterSecretStore setup
    ├── validator.ts        # ExternalSecret sync verification
    └── README.md           # This file

values/
├── deployments/
│   ├── acme-staging.yaml    # Deployment-specific secrets
│   └── acme-production.yaml
└── infrastructure/
    └── main.yaml                # ClusterSecretStore config

charts/
├── postgresql/
│   └── templates/
│       └── externalsecret.yaml  # ExternalSecret template
├── minio/
│   └── templates/
│       └── externalsecret.yaml
└── external-secrets-stores/
    └── templates/
        └── clustersecretstore.yaml
```

## Values File Patterns

### Pattern 1: Single Secret (PostgreSQL, External-DNS)

```yaml
postgresql:
  externalSecrets:
    enabled: true
    remoteKey: acme-staging-postgresql-password
    generator:
      generate: true
      type: password
      description: PostgreSQL admin password
```

### Pattern 2: Array of Secrets (MinIO, API)

```yaml
minio:
  externalSecrets:
    enabled: true
    secrets:
      - remoteKey: acme-staging-minio-root-password
        generator:
          generate: true
          type: password
          description: MinIO root password
```

### Generator Types

- `password`: Alphanumeric + special characters (default: 32 chars)
- `key`: Alphanumeric only (default: 32 chars)
- `token`: Hex-encoded (default: 32 bytes = 64 hex chars)
- `string`: Base64-encoded (default: 32 bytes)

### Generator Options

```yaml
generator:
  generate: true          # Enable auto-generation
  type: password          # Type of secret
  length: 64              # Optional: override default length
  description: Custom     # Optional: human-readable description
```

## CLI Commands

### Discover Secrets

Scan values files and show all discovered secrets:

```bash
# Discover all secrets
bun scripts/secrets-v2.ts discover

# Discover for specific deployment
bun scripts/secrets-v2.ts discover --deployment=acme-staging
```

**Output:**
```
Found 2 secrets across 2 deployments
Secrets with generator: 2

📦 acme-staging (1 secrets):
   postgresql: acme-staging-postgresql-password [PostgreSQL admin password (password, 32 chars)]
```

### Check GCP Secret Manager

Compare values files against actual secrets in GCP:

```bash
# Check all secrets
bun scripts/secrets-v2.ts check

# Check specific deployment
bun scripts/secrets-v2.ts check --deployment=acme-staging

# Dry run (don't connect to GCP)
bun scripts/secrets-v2.ts check --dry-run
```

**Output:**
```
📦 acme-staging:
   ✓ postgresql: acme-staging-postgresql-password
   ✗ minio: acme-staging-minio-root-password (can generate)

Total: 1 exist, 1 missing
```

### Setup ClusterSecretStore

Initialize ClusterSecretStore and show setup instructions:

```bash
bun scripts/secrets-v2.ts setup
```

**Output:**
```
Provider: gcp
Name: gcp-secretstore
Project ID: mc-v4-prod

📋 Setup Instructions:
1. Create service account:
   gcloud iam service-accounts create external-secrets --project=mc-v4-prod

2. Grant Secret Manager permissions:
   gcloud projects add-iam-policy-binding mc-v4-prod \
     --member="serviceAccount:external-secrets@mc-v4-prod.iam.gserviceaccount.com" \
     --role="roles/secretmanager.secretAccessor"

3. Create and download service account key:
   gcloud iam service-accounts keys create key.json \
     --iam-account=external-secrets@mc-v4-prod.iam.gserviceaccount.com

4. Create Kubernetes secret:
   kubectl create secret generic gcpsm-secret \
     --from-file=secret-access-credentials=key.json \
     --namespace=external-secrets-system
```

### Generate Secrets

Create missing secrets in GCP Secret Manager:

```bash
# Generate all missing secrets
bun scripts/secrets-v2.ts generate

# Generate for specific deployment
bun scripts/secrets-v2.ts generate --deployment=acme-staging

# Preview without creating
bun scripts/secrets-v2.ts generate --dry-run

# Skip confirmation
bun scripts/secrets-v2.ts generate --yes
```

**Output:**
```
Found 2 missing secrets

🤖 Auto-generate (1):
   acme-staging/postgresql: acme-staging-postgresql-password
     PostgreSQL admin password (password, 32 chars)

✍️  Manual input required (1):
   acme-staging/api: acme-staging-api-jwt-secret

Create 2 secrets in GCP? (Y/n)
Created 2/2 secrets
```

### Validate ExternalSecret Sync

Verify that ExternalSecrets are syncing correctly:

```bash
# Validate all ExternalSecrets
bun scripts/secrets-v2.ts validate

# Validate specific deployment
bun scripts/secrets-v2.ts validate --deployment=acme-staging

# Use specific kubeconfig
bun scripts/secrets-v2.ts validate --kubeconfig=~/.kube/acme-staging
```

**Output:**
```
📦 acme-staging (acme-staging):
   ✓ postgresql-credentials (synced)
   ⚠ minio-credentials (not synced)
     Error: secret "acme-staging-minio-root-password" not found

Total: 1/2 ready, 1 errors
```

### Full Sync Workflow

Run complete workflow: discover → check → generate → validate

```bash
# Full sync with all steps
bun scripts/secrets-v2.ts sync

# Specific deployment
bun scripts/secrets-v2.ts sync --deployment=acme-staging

# Preview mode
bun scripts/secrets-v2.ts sync --dry-run
```

## Common Workflows

### Adding a New Secret to an Existing Chart

1. **Update values file** (`values/deployments/acme-staging.yaml`):

```yaml
postgresql:
  externalSecrets:
    enabled: true
    remoteKey: acme-staging-postgresql-password
    generator:
      generate: true
      type: password
      description: PostgreSQL admin password
```

2. **Discover the secret**:

```bash
bun scripts/secrets-v2.ts discover --deployment=acme-staging
```

3. **Generate the secret**:

```bash
bun scripts/secrets-v2.ts generate --deployment=acme-staging
```

4. **Validate sync** (after deploying with ArgoCD):

```bash
bun scripts/secrets-v2.ts validate --deployment=acme-staging
```

### Adding Secrets for a New Chart

1. **Create ExternalSecret template** (`charts/new-service/templates/externalsecret.yaml`):

```yaml
{{- if and .Values.enabled .Values.externalSecrets.enabled }}
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: {{ include "new-service.fullname" . }}-credentials
  namespace: {{ include "new-service.namespace" . }}
spec:
  refreshInterval: {{ .Values.externalSecrets.refreshInterval | default "1h" }}
  secretStoreRef:
    name: {{ .Values.externalSecrets.secretStore | default "gcp-secretstore" }}
    kind: ClusterSecretStore
  target:
    name: {{ .Values.newService.auth.existingSecret | default "new-service" }}
    creationPolicy: Owner
    template:
      engineVersion: v2
      data:
        password: {{ `"{{ .password }}"` }}
  data:
    - secretKey: password
      remoteRef:
        key: {{ .Values.externalSecrets.remoteKey | required "externalSecrets.remoteKey is required" }}
{{- end }}
```

2. **Add to values** (`charts/new-service/values.yaml`):

```yaml
externalSecrets:
  enabled: false
  remoteKey: ""
  secretStore: "gcp-secretstore"
  refreshInterval: "1h"
```

3. **Configure in deployment** (`values/deployments/acme-staging.yaml`):

```yaml
newService:
  enabled: true
  externalSecrets:
    enabled: true
    remoteKey: acme-staging-new-service-password
    generator:
      generate: true
      type: password
      description: New service password
```

4. **Run full workflow**:

```bash
bun scripts/secrets-v2.ts sync --deployment=acme-staging
```

### Migrating from Old Architecture

The old architecture used separate `secrets.yaml` files. To migrate:

1. **Identify secrets** in old `secrets.yaml`:

```yaml
# OLD: deployments/acme-staging/secrets.yaml
secrets:
  - name: postgresql
    remoteRef: acme-staging-postgresql
    keys:
      - key: postgres-password
        remoteKey: acme-staging-postgresql-password
        generate: true
```

2. **Move to values file**:

```yaml
# NEW: values/deployments/acme-staging.yaml
postgresql:
  externalSecrets:
    enabled: true
    remoteKey: acme-staging-postgresql-password
    generator:
      generate: true
      type: password
      description: PostgreSQL admin password
```

3. **Delete old files**:

```bash
rm deployments/acme-staging/secrets.yaml
```

4. **Verify discovery**:

```bash
bun scripts/secrets-v2.ts discover
```

## ClusterSecretStore Configuration

ClusterSecretStore is managed by ArgoCD from `values/infrastructure/main.yaml`:

```yaml
externalSecrets:
  enabled: true
  provider: gcp
  
  stores:
    - name: gcp-secretstore
      provider: gcp
      gcp:
        projectId: "mc-v4-prod"
        auth:
          serviceAccountKey:
            enabled: true
            secretRef:
              name: gcpsm-secret
              key: secret-access-credentials
              namespace: external-secrets-system
```

Changes to this configuration will be automatically applied by ArgoCD.

## Troubleshooting

### Secret not syncing

1. **Check ExternalSecret status**:

```bash
kubectl get externalsecret -n acme-staging postgresql-credentials -o yaml
```

2. **Check conditions**:

```bash
kubectl get externalsecret -n acme-staging postgresql-credentials -o jsonpath='{.status.conditions}'
```

3. **Common issues**:
   - Secret doesn't exist in GCP: Run `bun scripts/secrets-v2.ts generate`
   - Wrong remote key: Check values file matches GCP secret name
   - ClusterSecretStore not ready: Run `bun scripts/secrets-v2.ts setup`

### Generator not working

Make sure the generator configuration is under `externalSecrets.generator`:

```yaml
# CORRECT
externalSecrets:
  enabled: true
  remoteKey: my-secret
  generator:  # ← Under externalSecrets
    generate: true
    type: password

# WRONG
externalSecrets:
  enabled: true
  remoteKey: my-secret
generator:  # ← Top-level (won't be detected)
  generate: true
  type: password
```

### Discovery not finding secrets

1. **Check if externalSecrets is enabled**:

```yaml
externalSecrets:
  enabled: true  # ← Must be true
```

2. **Verify file location**:
   - Deployment secrets: `values/deployments/*.yaml`
   - Infrastructure secrets: `values/infrastructure/*.yaml`

3. **Run with verbose output**:

```bash
bun scripts/secrets-v2.ts discover
```

## Migration Guide

### From secrets.yaml to values-driven

**Before** (old architecture):
```
deployments/acme-staging/
├── secrets.yaml           # Centralized secrets definition
└── values.yaml

infrastructure/
└── external-secrets/
    ├── gcp-secretstore.yaml           # Manual ClusterSecretStore
    └── postgresql-externalsecret.yaml # Manual ExternalSecret
```

**After** (new architecture):
```
values/deployments/
└── acme-staging.yaml  # Secrets defined inline with chart config

values/infrastructure/
└── main.yaml              # ClusterSecretStore config

charts/postgresql/
└── templates/
    └── externalsecret.yaml  # ExternalSecret template

charts/argocd-infrastructure/templates/
└── external-secrets-stores.yaml  # ArgoCD app for ClusterSecretStore
```

**Migration steps:**

1. For each secret in `secrets.yaml`, add to the corresponding chart in values file
2. Delete `secrets.yaml` files
3. Delete manual ExternalSecret YAML files (now generated from templates)
4. Run `bun scripts/secrets-v2.ts discover` to verify
5. Run `bun scripts/secrets-v2.ts check` to verify GCP secrets exist
6. Run `bun scripts/secrets-v2.ts validate` to verify ExternalSecret sync

## Best Practices

1. **Always use generator for passwords**: Don't store passwords in Git
2. **Use descriptive descriptions**: Helps identify secrets in GCP console
3. **Follow naming convention**: `{namespace}-{service}-{credential}`
4. **Run validate after deployment**: Ensures ExternalSecrets are syncing
5. **Use deployment filter for testing**: Test changes on staging first
6. **Keep secret types consistent**: Use `password` for passwords, `key` for API keys, etc.

## Security Notes

- Never commit actual secret values to Git
- Always use `generator.generate: true` for sensitive credentials
- Service account keys should have minimal permissions (Secret Manager Secret Accessor only)
- Rotate secrets regularly using `bun scripts/secrets-v2.ts generate --yes`
- Monitor ExternalSecret sync status in production
