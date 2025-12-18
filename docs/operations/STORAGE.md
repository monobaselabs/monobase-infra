# Storage Operations Guide

Cloud storage and MinIO object storage management.

## Quick Start: Choosing a Storage Provider

**Use `cloud-default`** for most deployments - it uses your cluster's native storage.

### Configuration

```yaml
# values/deployments/myclient-production.yaml
global:
  storage:
    provider: cloud-default  # Recommended for cloud deployments
    className: ""  # Empty = use cluster default
```

### Provider Options

**1. cloud-default (Recommended)**

Uses cluster's default StorageClass:
- AWS EKS → EBS CSI (gp2/gp3)
- Azure AKS → Azure Disk CSI
- GCP GKE → GCP Persistent Disk
- DigitalOcean DOKS → DO Block Storage
- No additional components to deploy!

**Pros:** Simple, managed, native integration
**Cons:** Cloud-specific, not portable

**2. Cloud-Specific Providers**

Explicitly use cloud provider's CSI driver:
- `ebs-csi` - AWS EBS volumes
- `azure-disk` - Azure managed disks
- `gcp-pd` - GCP persistent disks

**3. local-path (For k3d/kind Testing)**

Uses local-path-provisioner.

**Pros:** Simple, built-in to k3d/kind, perfect for testing
**Cons:** Not HA, not for production

**Use when:** Local development, CI/CD testing

### Provider Comparison

| Provider | Deployment | Management | Best For |
|----------|-----------|------------|----------|
| **cloud-default** | ✅ Auto | ☁️ Managed | Production (cloud) |
| **ebs-csi** | ✅ Auto | ☁️ Managed | AWS EKS |
| **azure-disk** | ✅ Auto | ☁️ Managed | Azure AKS |
| **gcp-pd** | ✅ Auto | ☁️ Managed | GCP GKE |
| **local-path** | ✅ Auto | 👤 Self | Dev/Testing |

---

## PostgreSQL Storage

PostgreSQL uses PersistentVolumeClaims that are automatically created with the configured storage provider.

### Configuration

```yaml
# values/deployments/myclient-production.yaml
postgresql:
  enabled: true
  postgresql:
    persistence:
      enabled: true
      storageClass: ""  # Uses global.storage.className
      size: 20Gi
```

### Storage Classes

#### Cloud Deployments

The storage class is automatically selected based on your cluster:

- **AWS EKS**: `gp3` (default) - GP3 SSD volumes
- **Azure AKS**: `managed-premium` - Premium SSD
- **GCP GKE**: `pd-ssd` - SSD persistent disks
- **DigitalOcean**: `do-block-storage` - Block storage volumes

#### Development

- **k3d/kind**: `local-path` - Local host path storage

### Volume Expansion

Most cloud storage classes support volume expansion:

```bash
# Check if StorageClass allows expansion
kubectl get storageclass -o custom-columns=NAME:.metadata.name,EXPANSION:.allowVolumeExpansion

# Expand PostgreSQL volume (example: 20Gi → 50Gi)
kubectl patch pvc data-postgresql-0 -n myclient-prod -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'

# Verify expansion
kubectl get pvc data-postgresql-0 -n myclient-prod
```

**Note:** Volume expansion is non-disruptive and happens online. The pod does not need to be restarted.

---

## MinIO Object Storage

MinIO provides S3-compatible object storage for files, images, and documents.

### MinIO Deployment

MinIO is deployed per client/environment via values configuration:

```yaml
# values/deployments/myclient-production.yaml
minio:
  enabled: true

  # External Secrets for root credentials
  externalSecrets:
    enabled: true
    secrets:
      - remoteKey: myclient-prod-minio-root-password
        generator:
          generate: true
          type: password

  # Bitnami MinIO subchart
  minio:
    mode: standalone
    statefulset:
      replicaCount: 1

    persistence:
      enabled: true
      storageClass: ""  # Uses global.storage.className
      size: 100Gi

    resources:
      requests:
        cpu: 250m
        memory: 512Mi
      limits:
        cpu: 1000m
        memory: 2Gi

    defaultBuckets: "monobase-files"

    # Gateway exposure
    gateway:
      enabled: true
      hostname: ""  # Auto: minio.{global.domain}
```

### MinIO Operations

#### Access MinIO UI

MinIO is exposed via HTTPRoute at `https://minio.{your-domain}`:

```bash
# Get MinIO credentials
kubectl get secret minio -n myclient-prod -o jsonpath='{.data.root-password}' | base64 -d

# Access UI
open https://minio.myclient.com
```

Default credentials:
- **Username**: `root`
- **Password**: From External Secrets or Kubernetes Secret

#### Create Buckets via mc CLI

```bash
# Install mc (MinIO Client)
brew install minio/stable/mc

# Configure alias
mc alias set myclient https://minio.myclient.com root <password>

# Create bucket
mc mb myclient/new-bucket

# List buckets
mc ls myclient/

# Upload files
mc cp ./file.pdf myclient/new-bucket/

# Set public policy
mc anonymous set download myclient/new-bucket
```

#### Bucket Management via UI

1. Navigate to `https://minio.myclient.com`
2. Log in with root credentials
3. Click **Buckets** → **Create Bucket**
4. Configure bucket policies and lifecycle rules

### MinIO Storage Expansion

Expand MinIO storage the same way as PostgreSQL:

```bash
# Expand MinIO volume (example: 100Gi → 200Gi)
kubectl patch pvc minio -n myclient-prod -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'

# Verify expansion
kubectl get pvc minio -n myclient-prod
```

### MinIO Backup

MinIO data is backed up via Velero (if enabled):

```bash
# Verify MinIO namespace is in Velero backup schedule
kubectl get schedule -n velero infrastructure-daily -o yaml | grep -A 10 includedNamespaces

# Trigger manual backup
velero backup create minio-manual --include-namespaces myclient-prod --selector app.kubernetes.io/name=minio
```

### MinIO Security

MinIO deployment includes:

- ✅ **Encrypted credentials** via External Secrets
- ✅ **TLS termination** at Envoy Gateway
- ✅ **NetworkPolicies** restricting access
- ✅ **Pod Security Standards** enforced
- ✅ **Read-only root filesystem** for container security

---

## Storage Monitoring

### Check Storage Usage

```bash
# View all PVCs in namespace
kubectl get pvc -n myclient-prod

# Detailed PVC information
kubectl describe pvc data-postgresql-0 -n myclient-prod

# Storage capacity
kubectl get pv | grep myclient-prod
```

### Cloud Provider Dashboards

Monitor storage through your cloud provider:

- **AWS**: CloudWatch → EBS metrics
- **Azure**: Azure Monitor → Disk metrics
- **GCP**: Cloud Monitoring → Persistent Disk metrics
- **DigitalOcean**: Control Panel → Volumes

---

## Troubleshooting

### PVC Pending

**Symptom**: PVC stuck in `Pending` state

```bash
# Check PVC events
kubectl describe pvc <pvc-name> -n <namespace>
```

**Common causes:**
1. **No StorageClass**: Cluster doesn't have a default StorageClass
   - Solution: Set `global.storage.className` explicitly
2. **Quota exceeded**: Cloud provider storage quota reached
   - Solution: Request quota increase from cloud provider
3. **Zone mismatch**: PVC and pod in different availability zones
   - Solution: Check node affinity and zone constraints

### Volume Expansion Stuck

**Symptom**: PVC shows `FileSystemResizePending`

```bash
# Check PVC status
kubectl get pvc <pvc-name> -n <namespace>

# Trigger filesystem resize by restarting pod
kubectl rollout restart statefulset/<name> -n <namespace>
```

### MinIO Connection Issues

**Symptom**: Applications can't connect to MinIO

```bash
# Check MinIO pod status
kubectl get pods -n myclient-prod -l app.kubernetes.io/name=minio

# Check MinIO service
kubectl get svc minio -n myclient-prod

# Test connectivity
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- \
  curl -v http://minio.myclient-prod.svc.cluster.local:9000
```

**Check HTTPRoute:**
```bash
# Verify MinIO HTTPRoute
kubectl get httproute -n myclient-prod | grep minio
kubectl describe httproute minio-httproute -n myclient-prod
```

### Storage Performance Issues

**Cloud Storage Performance:**
- **AWS EBS**: Upgrade from gp2 to gp3 for better performance/cost
- **Azure Disk**: Use Premium SSD for production workloads
- **GCP PD**: Use SSD persistent disks for databases

**Monitoring:**
```bash
# Check disk I/O in pod
kubectl exec -it postgresql-0 -n myclient-prod -- iostat -x 1 5

# Cloud provider metrics
# AWS: CloudWatch → EBS Volume IOPS
# Azure: Azure Monitor → Disk IOPS
# GCP: Cloud Monitoring → Disk ops/sec
```

---

## Best Practices

### Storage Planning

1. **Size appropriately**: Start with 2x expected data size
2. **Enable expansion**: Verify StorageClass supports `allowVolumeExpansion`
3. **Monitor usage**: Set up alerts at 70% capacity
4. **Plan for growth**: Cloud storage can expand dynamically

### Backup Strategy

1. **PostgreSQL**:
   - Tier 1: WAL archiving (if HA enabled)
   - Tier 2: Velero namespace backup (daily)
   - Tier 3: Cloud provider snapshots

2. **MinIO**:
   - Tier 1: Velero backup (daily)
   - Tier 2: MinIO bucket replication (optional)
   - Tier 3: Application-level versioning

### Cost Optimization

1. **Use appropriate tiers**:
   - Production: SSD/Premium storage
   - Staging: Standard/balanced storage
   - Development: Local path storage

2. **Right-size volumes**: Don't over-provision unnecessarily

3. **Cleanup unused PVCs**: Delete PVCs when scaling down

### Security

1. **Encrypt at rest**: Enable cloud provider encryption
2. **Access control**: Use RBAC and NetworkPolicies
3. **Credential management**: Use External Secrets for MinIO credentials
4. **Audit logging**: Enable cloud provider audit logs

---

## Related Documentation

- [BACKUP_DR.md](BACKUP_DR.md) - 3-tier backup strategy
- [SCALING-GUIDE.md](SCALING-GUIDE.md) - Storage scaling and HPA
- [Architecture: Storage](../architecture/ARCHITECTURE.md#storage-architecture) - Storage design decisions
- [Values Configuration](../reference/VALUES-CONFIGURATION.md) - Storage configuration parameters
