# Admin Script

Port-forwarding tool for Kubernetes admin UIs with automatic credential extraction.

## Overview

The admin script (`scripts/admin.ts`) provides quick access to cluster administration interfaces like ArgoCD, Grafana, Prometheus, MinIO, and Mailpit. It handles kubeconfig selection, service discovery, credential extraction, and port-forward tunnel management.

## Prerequisites

| Tool | Required | Purpose |
|------|----------|---------|
| `kubectl` | Yes | Kubernetes cluster interaction |

## Usage

```bash
# Interactive mode (prompts for all options)
bun scripts/admin.ts

# Direct service access
bun scripts/admin.ts --service argocd
bun scripts/admin.ts --service grafana
bun scripts/admin.ts --service prometheus

# With specific kubeconfig
bun scripts/admin.ts --kubeconfig ~/.kube/my-cluster

# With specific namespace (for per-deployment services)
bun scripts/admin.ts --service minio --namespace acme-staging

# Skip credential display
bun scripts/admin.ts --service grafana --no-credentials

# Legacy positional argument
bun scripts/admin.ts argocd
```

## Options

| Flag | Description |
|------|-------------|
| `--service <name>` | Service to access (see table below) |
| `--kubeconfig <path>` | Path to kubeconfig file |
| `--namespace <name>` | Override namespace selection |
| `--no-credentials` | Skip credential extraction |
| `--help` | Show help message |

## Supported Services

| Service | Namespace | Local Port | Credentials |
|---------|-----------|------------|-------------|
| `argocd` | `argocd` | 8080 | Secret: `argocd-initial-admin-secret` |
| `grafana` | `monitoring` | 8080 | Secret: `monitoring-grafana` |
| `prometheus` | `monitoring` | 9090 | None |
| `alertmanager` | `monitoring` | 9093 | None |
| `minio` | Per-deployment | 9001 | Secret: `minio` |
| `mailpit` | Per-deployment | 8025 | None (dev/staging only) |

## How It Works

### Interactive Flow

```mermaid
flowchart TD
    Start([Start]) --> Header[Display Header]
    Header --> KubeArg{"--kubeconfig provided?"}

    KubeArg -->|Yes| ValidateKube[Validate Kubeconfig Path]
    KubeArg -->|No| ScanKube["Scan ~/.kube/ for configs"]

    ValidateKube --> SetKube[Set KUBECONFIG env]
    ScanKube --> SelectKube[Prompt: Select Kubeconfig]
    SelectKube --> SetKube

    SetKube --> VerifyCluster[Verify Cluster Connection]
    VerifyCluster -->|Failed| Error1[Exit: Cluster unreachable]
    VerifyCluster -->|OK| ServiceArg{"--service provided?"}

    ServiceArg -->|Yes| ValidateService[Validate Service Name]
    ServiceArg -->|No| SelectService[Prompt: Select Service]

    ValidateService --> DetermineNS
    SelectService --> DetermineNS[Determine Namespace]

    DetermineNS --> NSType{Service Type?}
    NSType -->|Fixed Namespace| UseFixedNS[Use Configured Namespace]
    NSType -->|Per-Deployment| ScanNS[Scan Cluster for Service]

    UseFixedNS --> VerifyContext
    ScanNS --> SelectNS[Prompt: Select Namespace]
    SelectNS --> VerifyContext{Verify Context?}

    VerifyContext -->|Declined| Exit1[Exit: Switch context]
    VerifyContext -->|Confirmed| CheckService[Check Service Exists]

    CheckService -->|Not Found| Error2[Exit: Service not in namespace]
    CheckService -->|Found| DisplayInfo[Display Access Info]

    DisplayInfo --> NoCreds{"--no-credentials?"}
    NoCreds -->|Yes| StartPF
    NoCreds -->|No| ExtractCreds[Extract Credentials from Secret]

    ExtractCreds --> DisplayCreds[Display Username and Password]
    DisplayCreds --> StartPF[Start Port-Forward]

    StartPF --> WaitSignal["Wait for Ctrl+C"]
    WaitSignal --> Cleanup[Kill Port-Forward Process]
    Cleanup --> End([End])
```

### Service Selection Logic

```mermaid
flowchart TD
    SelectService[Select Service] --> CheckType{Service Type}

    CheckType -->|Fixed Namespace| Fixed[Use predefined namespace]
    Fixed --> ArgoCD["argocd namespace"]
    Fixed --> Monitoring["monitoring namespace"]

    CheckType -->|Per-Deployment| PerDeploy[Scan for service across namespaces]
    PerDeploy --> Found{Found in namespaces?}

    Found -->|Single| UseSingle[Auto-select namespace]
    Found -->|Multiple| PromptNS[Prompt user to select]
    Found -->|None| Error[Error: Service not found]
```

### Credential Extraction

```mermaid
flowchart LR
    Service[Service Config] --> SecretName[Secret Name]
    SecretName --> Kubectl["kubectl get secret"]
    Kubectl --> Base64[Base64 Encoded Data]
    Base64 --> Decode[Decode Values]
    Decode --> Display[Display Credentials]

    subgraph Keys
        Username["username or admin-user"]
        Password["password or admin-password"]
    end
```

## Service Details

### ArgoCD

```bash
bun scripts/admin.ts --service argocd
```

- **URL**: http://localhost:8080
- **Username**: `admin`
- **Password**: From `argocd-initial-admin-secret`

### Grafana

```bash
bun scripts/admin.ts --service grafana
```

- **URL**: http://localhost:8080
- **Username**: `admin`
- **Password**: From `monitoring-grafana` secret

### Prometheus

```bash
bun scripts/admin.ts --service prometheus
```

- **URL**: http://localhost:9090
- **No authentication required**

### MinIO (Per-Deployment)

```bash
bun scripts/admin.ts --service minio --namespace acme-staging
```

- **URL**: http://localhost:9001
- **Username**: From `minio` secret
- **Password**: From `minio` secret

### Mailpit (Per-Deployment)

```bash
bun scripts/admin.ts --service mailpit --namespace acme-staging
```

- **URL**: http://localhost:8025
- **No authentication required**
- **Note**: Dev/staging environments only

## Non-Interactive Mode

For automation or scripts, provide all required flags:

```bash
# Full non-interactive access
bun scripts/admin.ts \
  --kubeconfig ~/.kube/production \
  --service grafana \
  --no-credentials
```

When stdin is not a TTY, the script:
- Requires `--service` flag
- Auto-selects first available namespace for per-deployment services
- Skips context confirmation

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Kubeconfig not found` | Invalid path | Check file path |
| `Cluster unreachable` | Wrong context or cluster down | Verify cluster status |
| `Service not specified` | Non-interactive without `--service` | Provide `--service` flag |
| `Service not found in namespace` | Service not deployed | Check `kubectl get svc -n <namespace>` |
| `Secret not found` | Credentials not created | Check secret exists in namespace |

## Signal Handling

The script handles graceful shutdown:

- **SIGINT** (Ctrl+C): Kills port-forward subprocess, exits cleanly
- **SIGTERM**: Same as SIGINT

## Related Scripts

- [PROVISION.md](./PROVISION.md) - Provision cluster first
- [BOOTSTRAP.md](./BOOTSTRAP.md) - Install ArgoCD before accessing
- [SECRETS.md](./SECRETS.md) - Manage secrets for services like MinIO
