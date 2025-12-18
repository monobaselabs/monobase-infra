# Kyverno Resources Helm Chart

Kyverno policy enforcement rules for security, compliance, and governance.

## Overview

This chart deploys Kyverno ClusterPolicies that enforce:

- **Pod Security Standards**: Restricted security profile for all pods
- **Standard Labels**: Required labels for tracking and cost allocation
- **Registry Restrictions**: Only allow images from approved registries

## Prerequisites

- Kyverno installed in cluster
- Kubernetes 1.19+
- Helm 3.0+

## Installation

```bash
# Install with default settings (all policies enabled)
helm install kyverno-resources ./charts/kyverno-resources

# Install with audit mode for testing
helm install kyverno-resources ./charts/kyverno-resources \
  --set policies.podSecurity.validationFailureAction=audit \
  --set policies.requireLabels.validationFailureAction=audit

# Disable specific policies
helm install kyverno-resources ./charts/kyverno-resources \
  --set policies.restrictRegistries.enabled=false
```

## Configuration

### Key Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `policies.podSecurity.enabled` | Enable Pod Security Standards | `true` |
| `policies.podSecurity.validationFailureAction` | `enforce` or `audit` | `enforce` |
| `policies.requireLabels.enabled` | Require standard labels | `true` |
| `policies.requireLabels.validationFailureAction` | `enforce` or `audit` | `enforce` |
| `policies.restrictRegistries.enabled` | Restrict image registries | `true` |
| `policies.restrictRegistries.validationFailureAction` | `enforce` or `audit` | `audit` |
| `policies.restrictRegistries.allowedRegistries` | List of approved registries | See values.yaml |

See [values.yaml](values.yaml) for full configuration options.

## Policies

### Pod Security Standards (8 Rules)

Enforces Kubernetes Restricted security profile:

1. **Run as Non-Root**: Containers must set `runAsNonRoot=true`
2. **No Privilege Escalation**: Prevents `allowPrivilegeEscalation`
3. **Drop All Capabilities**: All Linux capabilities must be dropped
4. **Seccomp Profile**: Requires `RuntimeDefault` or `Localhost` seccomp
5. **No Host Namespaces**: Disallows `hostNetwork`, `hostPID`, `hostIPC`
6. **No HostPath Volumes**: Prevents direct host filesystem access
7. **No Privileged Containers**: Blocks `privileged=true`
8. **Restrict Volume Types**: Only allows safe volume types

### Require Standard Labels (4 Rules)

Enforces labels on Deployments, StatefulSets, DaemonSets:

**Required Labels:**
- `app`: Application name (e.g., `monobase-api`)
- `environment`: `production`, `staging`, or `development`
- `client`: Client identifier for multi-tenancy

**Example:**
```yaml
metadata:
  labels:
    app: monobase-api
    environment: production
    client: myclient
```

### Restrict Image Registries (1 Rule)

Only allows images from approved registries (default: audit mode):

**Default Approved Registries:**
- `ghcr.io/monobaselabs/*` (your organization)
- `bitnami/*` (trusted charts)
- `registry.k8s.io/*` (Kubernetes official)
- `quay.io/jetstack/*` (cert-manager)
- `docker.io/grafana/*`, `docker.io/prom/*` (monitoring)
- And more... (see values.yaml)

## Usage with ArgoCD

```yaml
# charts/argocd-infrastructure/templates/kyverno-policies.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: kyverno-policies
spec:
  source:
    path: charts/kyverno-resources
    helm:
      values: |
        policies:
          podSecurity:
            enabled: true
          requireLabels:
            enabled: true
          restrictRegistries:
            enabled: true
            allowedRegistries:
              - "ghcr.io/myorg/*"
```

## Testing Policies

### Test Pod Security Policy

```bash
# This should FAIL (no securityContext)
kubectl run test --image=nginx

# This should SUCCEED
kubectl run test --image=nginx \
  --dry-run=client -o yaml | \
kubectl patch -f - --dry-run=client -o yaml --type=json -p='[
  {"op":"add","path":"/spec/securityContext","value":{"runAsNonRoot":true,"seccompProfile":{"type":"RuntimeDefault"}}},
  {"op":"add","path":"/spec/containers/0/securityContext","value":{"runAsNonRoot":true,"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}
]' | kubectl apply -f -
```

### Test Label Policy

```bash
# This should FAIL (missing labels)
kubectl create deployment test --image=nginx

# This should SUCCEED
kubectl create deployment test --image=nginx \
  --dry-run=client -o yaml | \
kubectl label -f - --dry-run=client -o yaml \
  app=test environment=development client=myclient | \
kubectl apply -f -
```

### Test Registry Policy

```bash
# This should generate WARNING (audit mode, unauthorized registry)
kubectl run test --image=unknown-registry/nginx

# This should SUCCEED (approved registry)
kubectl run test --image=bitnami/nginx
```

## Switching from Audit to Enforce

Start with audit mode to see violations without blocking:

```bash
# Install in audit mode
helm install kyverno-resources ./charts/kyverno-resources \
  --set policies.podSecurity.validationFailureAction=audit

# Check violations
kubectl get policyreport -A

# When ready, upgrade to enforce mode
helm upgrade kyverno-resources ./charts/kyverno-resources \
  --set policies.podSecurity.validationFailureAction=enforce
```

## Development

```bash
# Lint chart
helm lint ./charts/kyverno-resources

# Dry-run
helm install --dry-run --debug kyverno-resources ./charts/kyverno-resources

# Template
helm template kyverno-resources ./charts/kyverno-resources
```

## Troubleshooting

### View Policy Reports

```bash
# View violations across all namespaces
kubectl get policyreport -A

# View specific policy violations
kubectl get clusterpolicyreport -o yaml

# View policy status
kubectl get clusterpolicy
```

### Bypass Policy for Specific Namespace

```yaml
# Add to ClusterPolicy
spec:
  rules:
  - name: my-rule
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
          - monitoring
```

## References

- [Kyverno Documentation](https://kyverno.io/docs/)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Kyverno Policy Library](https://kyverno.io/policies/)
