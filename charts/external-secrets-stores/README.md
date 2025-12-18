# External Secrets Stores Helm Chart

This chart creates ClusterSecretStore resources for the External Secrets Operator, enabling synchronization of secrets from cloud provider secret managers (GCP Secret Manager, AWS Secrets Manager, Azure Key Vault) into Kubernetes Secrets.

## Overview

ClusterSecretStore is a cluster-scoped resource that defines **HOW** to connect to your cloud provider's secret manager. Individual ExternalSecret resources reference a ClusterSecretStore to define **WHAT** secrets to sync.

## Supported Providers

- **GCP Secret Manager** - Google Cloud Platform
- **AWS Secrets Manager** - Amazon Web Services
- **Azure Key Vault** - Microsoft Azure

## Prerequisites

- External Secrets Operator installed in the cluster
- Cloud provider authentication configured (Service Account Key, Workload Identity, IRSA, etc.)
- Secret containing cloud provider credentials (if not using Workload Identity)

## Configuration

### GCP Secret Manager

#### Using Service Account Key (works on any Kubernetes cluster)

```yaml
stores:
  - name: gcp-secretstore
    provider: gcp
    gcp:
      projectId: "my-gcp-project"
      auth:
        serviceAccountKey:
          enabled: true
          secretRef:
            name: gcpsm-secret
            key: secret-access-credentials
            namespace: external-secrets-system
```

#### Using Workload Identity (GKE only)

```yaml
stores:
  - name: gcp-secretstore
    provider: gcp
    gcp:
      projectId: "my-gcp-project"
      auth:
        workloadIdentity:
          enabled: true
          clusterLocation: us-central1
          clusterName: my-cluster
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets-system
```

### AWS Secrets Manager

#### Using IRSA (IAM Roles for Service Accounts)

```yaml
stores:
  - name: aws-secretstore
    provider: aws
    aws:
      region: us-east-1
      service: SecretsManager
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets-system
```

### Azure Key Vault

#### Using Workload Identity

```yaml
stores:
  - name: azure-secretstore
    provider: azure
    azure:
      vaultUrl: "https://my-vault.vault.azure.net"
      tenantId: "12345678-1234-1234-1234-123456789012"
      auth:
        workloadIdentity:
          enabled: true
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets-system
```

## Multiple Providers

You can configure multiple ClusterSecretStores for different providers or different projects:

```yaml
stores:
  # Production GCP project
  - name: gcp-prod-secretstore
    provider: gcp
    gcp:
      projectId: "my-company-prod"
      auth:
        serviceAccountKey:
          enabled: true
          secretRef:
            name: gcpsm-prod-secret
            key: secret-access-credentials
            namespace: external-secrets-system

  # Staging GCP project
  - name: gcp-staging-secretstore
    provider: gcp
    gcp:
      projectId: "my-company-staging"
      auth:
        serviceAccountKey:
          enabled: true
          secretRef:
            name: gcpsm-staging-secret
            key: secret-access-credentials
            namespace: external-secrets-system

  # AWS for backup secrets
  - name: aws-secretstore
    provider: aws
    aws:
      region: us-east-1
      service: SecretsManager
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets-system
```

## Installation

This chart is typically deployed via ArgoCD as part of infrastructure setup:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: external-secrets-stores
  namespace: argocd
spec:
  source:
    repoURL: https://github.com/yourorg/monobase-infra.git
    path: charts/external-secrets-stores
    helm:
      valuesObject:
        stores:
          - name: gcp-secretstore
            provider: gcp
            gcp:
              projectId: "my-project"
              auth:
                serviceAccountKey:
                  enabled: true
                  secretRef:
                    name: gcpsm-secret
                    key: secret-access-credentials
                    namespace: external-secrets-system
```

## Usage with ExternalSecrets

After deploying a ClusterSecretStore, reference it in your ExternalSecret resources:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: my-app-secrets
  namespace: my-app
spec:
  secretStoreRef:
    name: gcp-secretstore  # References ClusterSecretStore
    kind: ClusterSecretStore
  target:
    name: my-app-secrets
    creationPolicy: Owner
  data:
    - secretKey: database-password
      remoteRef:
        key: my-app-production-database-password
```

## Values Reference

### Global Parameters

| Parameter | Description | Type | Required |
|-----------|-------------|------|----------|
| `stores` | List of ClusterSecretStore configurations | array | Yes |

### Store Parameters

| Parameter | Description | Type | Required |
|-----------|-------------|------|----------|
| `name` | Name of the ClusterSecretStore | string | Yes |
| `provider` | Cloud provider (`gcp`, `aws`, `azure`) | string | Yes |

### GCP Parameters

| Parameter | Description | Type | Required |
|-----------|-------------|------|----------|
| `gcp.projectId` | GCP project ID | string | Yes |
| `gcp.auth.workloadIdentity.enabled` | Enable Workload Identity | boolean | No |
| `gcp.auth.workloadIdentity.clusterLocation` | GKE cluster location | string | If WI enabled |
| `gcp.auth.workloadIdentity.clusterName` | GKE cluster name | string | If WI enabled |
| `gcp.auth.serviceAccountKey.enabled` | Enable Service Account Key | boolean | No |
| `gcp.auth.serviceAccountKey.secretRef.name` | Secret name containing SA key | string | If SA Key enabled |
| `gcp.auth.serviceAccountKey.secretRef.key` | Key within secret | string | If SA Key enabled |
| `gcp.auth.serviceAccountKey.secretRef.namespace` | Secret namespace | string | If SA Key enabled |

### AWS Parameters

| Parameter | Description | Type | Required |
|-----------|-------------|------|----------|
| `aws.region` | AWS region | string | Yes |
| `aws.service` | AWS service (default: SecretsManager) | string | No |
| `aws.auth.jwt.serviceAccountRef.name` | ServiceAccount name | string | No (default: external-secrets) |
| `aws.auth.jwt.serviceAccountRef.namespace` | ServiceAccount namespace | string | No (default: external-secrets-system) |

### Azure Parameters

| Parameter | Description | Type | Required |
|-----------|-------------|------|----------|
| `azure.vaultUrl` | Azure Key Vault URL | string | Yes |
| `azure.tenantId` | Azure tenant ID | string | No |
| `azure.auth.workloadIdentity.enabled` | Enable Workload Identity | boolean | Yes |
| `azure.auth.workloadIdentity.serviceAccountRef.name` | ServiceAccount name | string | No (default: external-secrets) |
| `azure.auth.workloadIdentity.serviceAccountRef.namespace` | ServiceAccount namespace | string | No (default: external-secrets-system) |

## Troubleshooting

### Store not ready

```bash
kubectl get clustersecretstore
```

Check the status and conditions:

```bash
kubectl describe clustersecretstore gcp-secretstore
```

### Authentication failures

For GCP Service Account Key:
```bash
kubectl get secret gcpsm-secret -n external-secrets-system -o yaml
```

For Workload Identity, verify the ServiceAccount annotation:
```bash
kubectl get sa external-secrets -n external-secrets-system -o yaml
```

## See Also

- [External Secrets Operator Documentation](https://external-secrets.io/)
- [GCP Secret Manager Provider](https://external-secrets.io/latest/provider/google-secrets-manager/)
- [AWS Secrets Manager Provider](https://external-secrets.io/latest/provider/aws-secrets-manager/)
- [Azure Key Vault Provider](https://external-secrets.io/latest/provider/azure-key-vault/)
