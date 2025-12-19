# Bootstrap Script

Unified ArgoCD installation and GitOps cluster bootstrap.

## Overview

The bootstrap script (`scripts/bootstrap.ts`) sets up a complete GitOps pipeline using ArgoCD. It handles ArgoCD installation, GitHub App authentication for private repositories, and deploys the infrastructure root application that manages all cluster components.

## Prerequisites

| Tool | Required | Purpose |
|------|----------|---------|
| `kubectl` | Yes | Kubernetes cluster interaction |
| `helm` | Yes | Package management for ArgoCD |
| `gcloud` | Optional | GCP Secret Manager integration |

## Usage

```bash
# Basic bootstrap
bun scripts/bootstrap.ts

# Skip ArgoCD installation (already installed)
bun scripts/bootstrap.ts --skip-argocd

# Skip GitHub App setup (public repo)
bun scripts/bootstrap.ts --skip-github-app

# Wait for full application sync
bun scripts/bootstrap.ts --wait

# Non-interactive mode
bun scripts/bootstrap.ts --yes

# Destroy cluster bootstrap
bun scripts/bootstrap.ts --destroy

# Destroy with specific mode
bun scripts/bootstrap.ts --destroy --mode cascade
```

## Options

### Bootstrap Flags

| Flag | Description |
|------|-------------|
| `--kubeconfig <path>` | Custom kubeconfig file |
| `--context <name>` | Kubernetes context to use |
| `--skip-argocd` | Skip ArgoCD installation |
| `--skip-github-app` | Skip GitHub App setup |
| `--wait` | Wait for full application sync |
| `--dry-run` | Preview without executing |
| `--yes` | Auto-approve (non-interactive) |

### GitHub App Flags

| Flag | Description |
|------|-------------|
| `--app-id <id>` | GitHub App ID |
| `--installation-id <id>` | Installation ID |
| `--private-key-path <path>` | Path to private key file |

### Destruction Flags

| Flag | Description |
|------|-------------|
| `--destroy` | Enable destruction mode |
| `--mode <mode>` | `cascade`, `orphan`, or `argocd-only` |

## How It Works

### Bootstrap Flow

```mermaid
flowchart TD
    Start([Start]) --> Prerequisites{Validate Prerequisites}
    Prerequisites -->|Missing tools| Error1["Exit: Install kubectl or helm"]
    Prerequisites -->|OK| SelectContext[Select Kubernetes Context]

    SelectContext --> ConfirmContext{Confirm Context?}
    ConfirmContext -->|No| Exit1[Exit: Switch context manually]
    ConfirmContext -->|Yes| CheckRepo{Private Repository?}

    CheckRepo -->|No| SkipGithub[Skip GitHub App Setup]
    CheckRepo -->|Yes| GithubSetup[GitHub App Setup]

    GithubSetup --> CheckGCP{Credentials in GCP?}
    CheckGCP -->|Yes| UseExisting[Use Existing Credentials]
    CheckGCP -->|No| PromptCreds[Prompt for Credentials]

    PromptCreds --> ValidateKey[Validate Private Key]
    ValidateKey --> StoreGCP[Store in GCP Secret Manager]
    StoreGCP --> CreateExtSecret[Create ExternalSecret Manifest]

    UseExisting --> SkipArgo
    CreateExtSecret --> SkipArgo{Skip ArgoCD?}
    SkipGithub --> SkipArgo

    SkipArgo -->|Yes| BootstrapInfra
    SkipArgo -->|No| InstallArgo[Install ArgoCD via Helm]

    InstallArgo --> WaitArgo[Wait for ArgoCD Ready]
    WaitArgo --> BootstrapInfra[Deploy Infrastructure Root]

    BootstrapInfra --> DeployAppSet[Deploy ApplicationSet]
    DeployAppSet --> WaitFlag{--wait flag?}

    WaitFlag -->|No| DisplayResults
    WaitFlag -->|Yes| WaitSync[Wait for Application Sync]

    WaitSync --> DisplayResults["Display Results and Next Steps"]
    DisplayResults --> End([End])
```

### Destruction Modes

```mermaid
flowchart LR
    subgraph Cascade["cascade mode"]
        C1[Delete ApplicationSets] --> C2[Delete Applications]
        C2 --> C3[Delete Resources]
        C3 --> C4[Uninstall ArgoCD]
    end

    subgraph Orphan["orphan mode"]
        O1[Delete ApplicationSets] --> O2[Delete Applications]
        O2 --> O3[Keep Resources Running]
        O3 --> O4[Uninstall ArgoCD]
    end

    subgraph ArgoCDOnly["argocd-only mode"]
        A1[Keep Applications] --> A2[Keep Resources]
        A2 --> A3[Uninstall ArgoCD Only]
    end
```

### Three-Tier Deployment Architecture

```mermaid
flowchart TB
    subgraph Layer1["Layer 1: ArgoCD Core"]
        ArgoCD[ArgoCD Server]
    end

    subgraph Layer2["Layer 2: Infrastructure"]
        InfraRoot[Infrastructure Root App]
        InfraRoot --> CertManager[cert-manager]
        InfraRoot --> ExtDNS[external-dns]
        InfraRoot --> ExtSecrets[external-secrets]
        InfraRoot --> Monitoring[monitoring]
        InfraRoot --> Gateways[gateways]
        InfraRoot --> Security[security]
        InfraRoot --> Backup[backup]
    end

    subgraph Layer3["Layer 3: Applications"]
        AppSet[ApplicationSet]
        AppSet --> Client1[client-a-prod]
        AppSet --> Client2[client-b-staging]
        AppSet --> ClientN[client-n-env]
    end

    ArgoCD --> InfraRoot
    ArgoCD --> AppSet

    subgraph Discovery["Auto-Discovery"]
        ValuesDir["values/deployments/*.yaml"]
    end

    Discovery -.->|scans| AppSet
```

### GitOps Workflow

```mermaid
flowchart LR
    Git[(Git Repository)] --> AppSet[ApplicationSet]
    AppSet --> App1[Application 1]
    AppSet --> App2[Application 2]

    App1 --> NS1[Namespace 1]
    App2 --> NS2[Namespace 2]

    NS1 --> Services1[Services]
    NS2 --> Services2[Services]

    subgraph Sync["Continuous Sync"]
        direction TB
        Poll[Poll Repository] --> Detect[Detect Changes]
        Detect --> Apply[Apply to Cluster]
    end
```

## GitHub App Setup

For private repositories, the script guides you through GitHub App creation:

1. **Create GitHub App** at `https://github.com/settings/apps/new`
2. **Configure Permissions**: Repository contents (read-only)
3. **Install App** on your repository
4. **Provide Credentials**: App ID, Installation ID, Private Key
5. **Credentials are stored** in GCP Secret Manager
6. **ExternalSecret** syncs credentials to Kubernetes

### Credential Flow

```mermaid
flowchart LR
    GH[GitHub App] --> PK[Private Key]
    PK --> GCP[GCP Secret Manager]
    GCP --> ESO[External Secrets Operator]
    ESO --> K8S[Kubernetes Secret]
    K8S --> ArgoCD[ArgoCD]
    ArgoCD --> Repo[Private Repository]
```

## Configuration

### Key Files

| Path | Purpose |
|------|---------|
| `values/infrastructure/main.yaml` | ArgoCD and infrastructure configuration |
| `charts/argocd-bootstrap/` | Bootstrap Helm chart |
| `values/deployments/*.yaml` | Per-client/environment configurations |
| `backups/applications-*/` | Application backups before destruction |

### ArgoCD Configuration

| Setting | Value |
|---------|-------|
| Chart Version | 7.7.12 |
| Replicas | 1 (non-HA) |
| Repo Server Memory | 1536Mi request / 2560Mi limit |
| Sync Timeout | 10-20 minutes |

## Destruction Modes Comparison

| Mode | Applications | Resources | ArgoCD | Use Case |
|------|--------------|-----------|--------|----------|
| `cascade` | Deleted | Deleted | Removed | Full cleanup |
| `orphan` | Deleted | **Kept** | Removed | Keep workloads, remove GitOps |
| `argocd-only` | **Kept** | **Kept** | Removed | Just remove ArgoCD |

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `kubectl not found` | Missing CLI | Install kubectl |
| `helm not found` | Missing package manager | Install Helm |
| `Cluster unreachable` | Wrong context or down | Check kubeconfig and cluster |
| `Private key invalid` | Wrong format | Use PEM format RSA key |
| `ArgoCD not ready` | Installation failed | Check ArgoCD pods in `argocd` namespace |

## Related Scripts

- [PROVISION.md](./PROVISION.md) - Provision cluster before bootstrap
- [ADMIN.md](./ADMIN.md) - Access ArgoCD UI after bootstrap
- [SECRETS.md](./SECRETS.md) - Manage application secrets
