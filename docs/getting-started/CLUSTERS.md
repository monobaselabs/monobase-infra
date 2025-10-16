# Cluster Provisioning Guide

Complete guide for provisioning Kubernetes clusters using the example configurations in `clusters/`.

## Quick Reference

| Example | Provider | Profile | Use Case | Quick Start |
|---------|----------|---------|----------|-------------|
| **example-aws-eks** | AWS EKS | Production | Multi-client production | `cp -r clusters/example-aws-eks clusters/myclient-eks` |
| **example-azure-aks** | Azure AKS | Production | Azure-based production | `cp -r clusters/example-azure-aks clusters/myclient-aks` |
| **example-gcp-gke** | GCP GKE | Production | GCP-based production | `cp -r clusters/example-gcp-gke clusters/myclient-gke` |
| **example-do-doks** | DigitalOcean | Cost-effective | Budget-conscious prod | `cp -r clusters/example-do-doks clusters/myclient-doks` |
| **example-k3d** | Local (Docker) | Development | Local testing/dev | `cp -r clusters/example-k3d clusters/k3d-local` |
| **example-k3s** | On-Premises | Self-hosted | Bare-metal/VM clusters | `cp -r clusters/example-k3s clusters/myclient-k3s` |

## Workflow

### 1. Choose and Copy Example

```bash
# Choose based on your provider
cp -r clusters/example-aws-eks clusters/myclient-eks
# OR
cp -r clusters/example-do-doks clusters/myclient-doks
# OR
cp -r clusters/example-k3d clusters/k3d-local
```

### 2. Customize Configuration

```bash
cd clusters/myclient-eks
vim terraform.tfvars
```

**Required changes:**
- `cluster_name` - Your cluster identifier
- `region` - Your AWS/Azure/GCP region
- `deployment_profile` - small/medium/large (or custom node_groups)

### 3. Provision Cluster

```bash
./scripts/provision.sh --cluster myclient-eks
```

The script automatically:
- ✅ Initializes Terraform
- ✅ Creates cluster infrastructure
- ✅ Saves kubeconfig to `~/.kube/myclient-eks`
- ✅ Tests connectivity with `kubectl cluster-info`

### 4. Bootstrap GitOps

```bash
# Install ArgoCD and enable auto-discovery (one-time)
./scripts/bootstrap.sh
```

## Configuration Options

### Deployment Profiles (Recommended)

Most modules support size presets for quick configuration:

```hcl
# terraform.tfvars
deployment_profile = "small"   # 1-5 clients, 3 nodes, ~12 vCPU
deployment_profile = "medium"  # 5-15 clients, 5 nodes, ~20 vCPU
deployment_profile = "large"   # 15+ clients, 5+ larger nodes, ~40+ vCPU
```

### Custom Node Groups (Advanced)

For fine-grained control over node configuration:

```hcl
# terraform.tfvars
node_groups = {
  general = {
    instance_types = ["m6i.xlarge"]  # 4 vCPU, 16GB RAM
    desired_size   = 3
    min_size       = 3
    max_size       = 10
    disk_size      = 100
    labels         = { role = "general" }
    taints         = []
  }

  compute = {
    instance_types = ["c6i.2xlarge"]  # 8 vCPU, 16GB RAM
    desired_size   = 2
    min_size       = 0
    max_size       = 5
    labels         = { role = "compute" }
  }
}
```

## Provider-Specific Details

### AWS EKS

**Module:** [terraform/modules/aws-eks](../../terraform/modules/aws-eks/README.md)

**Features:**
- Automatic VPC creation with public/private subnets
- IRSA (IAM Roles for Service Accounts) enabled
- Node groups with auto-scaling
- EBS CSI driver for persistent storage
- Add-ons: vpc-cni, kube-proxy, coredns

**Authentication:**
```bash
aws configure
# OR
export AWS_ACCESS_KEY_ID=xxx
export AWS_SECRET_ACCESS_KEY=xxx
```

**Outputs:**
- `cluster_endpoint` - EKS API server endpoint
- `kubeconfig_command` - Command to configure kubectl
- `oidc_provider_arn` - For IRSA integration

### DigitalOcean DOKS

**Module:** [terraform/modules/do-doks](../../terraform/modules/do-doks/README.md)

**Features:**
- Managed Kubernetes (simpler than EKS/AKS/GKE)
- Cost-effective ($12/node/month for basic droplets)
- Automatic LoadBalancer integration
- Built-in monitoring and logging

**Authentication:**
```bash
export DIGITALOCEAN_TOKEN=your-token
```

**Best for:** Budget-conscious production deployments, startups, small teams

### Local k3d

**Module:** [terraform/modules/local-k3d](../../terraform/modules/local-k3d/README.md)

**Features:**
- Runs in Docker containers (no VMs needed)
- Fast cluster creation (~30 seconds)
- Port forwarding for LoadBalancer services
- Ideal for local development and testing

**Prerequisites:**
- Docker Desktop or Docker Engine running
- k3d installed: `brew install k3d` or `curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash`

**Best for:** Local development, testing, CI pipelines

### Azure AKS

**Module:** [terraform/modules/azure-aks](../../terraform/modules/azure-aks/README.md)

**Authentication:**
```bash
az login
```

### GCP GKE

**Module:** [terraform/modules/gcp-gke](../../terraform/modules/gcp-gke/README.md)

**Authentication:**
```bash
gcloud auth application-default login
```

### On-Premises K3s

**Module:** [terraform/modules/on-prem-k3s](../../terraform/modules/on-prem-k3s/README.md)

**Best for:** Bare-metal servers, edge computing, air-gapped environments

## Next Steps

After cluster provisioning:

### 1. Verify Cluster

```bash
kubectl cluster-info
kubectl get nodes
```

### 2. Bootstrap GitOps

```bash
./scripts/bootstrap.sh
```

This installs:
- ArgoCD (GitOps engine)
- Infrastructure ApplicationSet (cluster-wide components)
- Auto-discovery ApplicationSet (per-client deployments)

### 3. Create First Deployment

```bash
# Copy appropriate example
cp -r deployments/example-prod deployments/myclient-prod

# Customize
vim deployments/myclient-prod/values.yaml
# Change: domain, namespace, image tags

# Deploy via Git
git add deployments/myclient-prod/
git commit -m "Add myclient-prod deployment"
git push  # ArgoCD auto-deploys!
```

## Cleanup

To destroy a cluster:

```bash
cd clusters/myclient-eks
terraform destroy
```

**⚠️ Warning:** This destroys ALL cluster resources. Ensure you have:
- ✅ Velero backups configured and tested
- ✅ Database dumps if needed
- ✅ Important data backed up externally

## Troubleshooting

### Terraform Initialization Fails

```bash
cd clusters/myclient-eks
rm -rf .terraform .terraform.lock.hcl
terraform init
```

### Cluster Creation Times Out

Check cloud provider quotas:
- **AWS**: VPC limits, EIP limits, instance quotas
- **Azure**: Core quotas per region
- **GCP**: Compute Engine API quota

### Kubeconfig Not Working

```bash
# Re-export kubeconfig
cd clusters/myclient-eks
terraform output -raw kubeconfig > ~/.kube/myclient-eks
export KUBECONFIG=~/.kube/myclient-eks
kubectl cluster-info
```

## Related Documentation

- [Infrastructure Requirements](./INFRASTRUCTURE-REQUIREMENTS.md) - Minimum cluster specs
- [Deployment Guide](./DEPLOYMENT.md) - Application deployment workflow
- [GitOps Architecture](../architecture/GITOPS-ARGOCD.md) - How ArgoCD manages deployments
- [Cluster Provisioning Details](./CLUSTER-PROVISIONING.md) - Deep dive into provisioning process
