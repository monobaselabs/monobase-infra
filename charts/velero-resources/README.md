# Velero Resources Helm Chart

BackupStorageLocations and Backup Schedules for Velero disaster recovery.

## Overview

This chart deploys Velero backup configuration resources:

- **BackupStorageLocations**: Cloud storage configuration for backups (S3, Azure Blob, GCS, DO Spaces)
- **VolumeSnapshotLocations**: Cloud volume snapshot configuration
- **Backup Schedules**: Automated backup schedules (hourly, daily, weekly)

## Prerequisites

- Velero installed in cluster (creates Velero CRDs)
- Cloud storage bucket created (S3, Azure Blob, GCS, or DO Spaces)
- Cloud credentials configured (IRSA, Workload Identity, or Secret)

## Installation

```bash
# AWS S3
helm install velero-resources ./charts/velero-resources \
  --set velero.provider=aws \
  --set velero.aws.region=us-east-1 \
  --set velero.aws.bucket=my-backup-bucket

# Azure Blob Storage
helm install velero-resources ./charts/velero-resources \
  --set velero.provider=azure \
  --set velero.azure.resourceGroup=my-rg \
  --set velero.azure.storageAccount=myaccount \
  --set velero.azure.blobContainer=velero-backups

# GCP Cloud Storage
helm install velero-resources ./charts/velero-resources \
  --set velero.provider=gcp \
  --set velero.gcp.project=my-project \
  --set velero.gcp.bucket=my-backup-bucket

# DigitalOcean Spaces
helm install velero-resources ./charts/velero-resources \
  --set velero.provider=digitalocean \
  --set velero.digitalocean.region=nyc3 \
  --set velero.digitalocean.bucket=my-backup-space
```

## Configuration

### Key Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `velero.enabled` | Enable Velero resources | `true` |
| `velero.provider` | Cloud provider | `aws` |
| `velero.aws.region` | AWS region | `us-east-1` |
| `velero.aws.bucket` | S3 bucket name | `""` (required) |
| `velero.schedules.infrastructure.hourly.enabled` | Enable hourly backups | `true` |
| `velero.schedules.infrastructure.daily.schedule` | Daily backup cron | `"0 3 * * *"` |
| `velero.schedules.infrastructure.weekly.ttl` | Weekly backup retention | `720h` (30 days) |

See [values.yaml](values.yaml) for full configuration options.

## Backup Schedules

### Infrastructure Backups

Backs up cluster infrastructure (cert-manager, external-secrets, argocd, velero, etc.):

- **Hourly**: Every hour, retained for 72 hours (3 days)
- **Daily**: 3 AM daily, retained for 7 days
- **Weekly**: 4 AM Sunday, retained for 30 days

### Application Backups

Backs up application namespaces (per-client deployments):

- **Daily**: 2 AM daily, retained for 7 days
- **Weekly**: 3 AM Sunday, retained for 30 days

## Cloud Provider Configuration

### AWS (IRSA Authentication)

```yaml
velero:
  provider: aws
  aws:
    region: us-east-1
    bucket: my-velero-backups
```

Velero uses IRSA (IAM Roles for Service Accounts) - no secret needed.

### Azure (Workload Identity)

```yaml
velero:
  provider: azure
  azure:
    resourceGroup: my-resource-group
    storageAccount: mybackupstorage
    blobContainer: velero-backups
```

### GCP (Workload Identity)

```yaml
velero:
  provider: gcp
  gcp:
    project: my-gcp-project
    bucket: my-velero-backups
```

### DigitalOcean Spaces

```yaml
velero:
  provider: digitalocean
  digitalocean:
    region: nyc3
    bucket: my-backup-space
```

Requires Velero credentials secret with DO access keys.

## Usage with ArgoCD

Deployed automatically via ArgoCD when `velero.enabled=true`:

```yaml
# charts/argocd-infrastructure/templates/velero-resources.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: velero-resources
spec:
  source:
    chart: velero-resources
    path: charts/velero-resources
  helm:
    values: |
      velero:
        provider: {{ .Values.velero.provider }}
        aws:
          bucket: {{ .Values.velero.aws.bucket }}
```

## Backup Verification

```bash
# Check backup storage location
kubectl get backupstoragelocation -n velero

# Check backup schedules
kubectl get schedule -n velero

# Trigger manual backup
velero backup create manual-backup --include-namespaces default

# List backups
velero backup get
```

## Development

```bash
# Lint chart
helm lint ./charts/velero-resources

# Dry-run
helm install --dry-run --debug velero-resources ./charts/velero-resources \
  --set velero.aws.bucket=test-bucket

# Template
helm template velero-resources ./charts/velero-resources
```
