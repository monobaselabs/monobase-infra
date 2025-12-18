# Monobase Provider Helm Chart

Helm chart for deploying the Monobase Provider frontend application.

## Overview

The Monobase Provider chart deploys the frontend web application that users interact with.

**Key features:**
- Static frontend (Next.js, React, or similar)
- Gateway API HTTPRoute for routing
- No dependencies (calls API backend)
- Lightweight resource requirements

## Quick Start

```yaml
# deployments/myclient-prod/values.yaml
provider:
  enabled: true
  replicaCount: 2
  image:
    repository: ghcr.io/monobaselabs/providerapp
    tag: "1.0.0"
```

Deploy via ArgoCD (GitOps) or Helm:

```bash
# GitOps (recommended)
git add deployments/myclient-prod/values.yaml && git commit && git push

# Manual Helm install
helm install myclient-account ./charts/account -f deployments/myclient-prod/values.yaml
```

## Parameters

### provider.enabled
- **Type:** boolean
- **Default:** `true`
- **Description:** Enable or disable Provider frontend deployment

### provider.replicaCount
- **Type:** integer
- **Default:** `2`
- **Staging:** `1`
- **Production:** `2-3`
- **Description:** Number of frontend pod replicas

### provider.image.repository
- **Type:** string
- **Default:** `ghcr.io/monobaselabs/providerapp`
- **Description:** Container image repository

### provider.image.tag
- **Type:** string
- **Default:** `1.0.0`
- **Production:** Pin specific version
- **Description:** Container image tag

### provider.image.pullPolicy
- **Type:** string
- **Default:** `IfNotPresent`
- **Options:** `Always`, `IfNotPresent`, `Never`

## Resource Configuration

### provider.resources.requests.cpu
- **Type:** string
- **Default:** `200m`
- **Production:** `200m-500m`
- **Description:** Guaranteed CPU allocation (frontend is lightweight)

### provider.resources.requests.memory
- **Type:** string
- **Default:** `512Mi`
- **Production:** `512Mi-1Gi`
- **Description:** Guaranteed memory allocation

### provider.resources.limits.cpu
- **Type:** string
- **Default:** `500m`
- **Production:** `500m-1`
- **Description:** Maximum CPU allowed

### provider.resources.limits.memory
- **Type:** string
- **Default:** `1Gi`
- **Production:** `1-2Gi`
- **Description:** Maximum memory allowed

## Gateway Configuration

### provider.gateway.hostname
- **Type:** string
- **Default:** Empty (uses `provider.{global.domain}`)
- **Example:** `provider.myclient.com` or `portal.custom-domain.com`
- **Description:** Custom hostname for frontend. If empty, defaults to provider.{global.domain}

## High Availability

### provider.podDisruptionBudget.enabled
- **Type:** boolean
- **Default:** `true`
- **Production:** `true` (recommended for HA)

### provider.podDisruptionBudget.minAvailable
- **Type:** integer
- **Default:** `1`
- **Description:** Minimum pods that must remain available during disruptions

## Configuration Examples

### Minimal Configuration (Staging)

```yaml
provider:
  enabled: true
  replicaCount: 1
  image:
    tag: "latest"
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
```

### Production Configuration (HA)

```yaml
provider:
  enabled: true
  replicaCount: 2
  image:
    tag: "1.0.0"  # Pin version
  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: 500m
      memory: 1Gi
  podDisruptionBudget:
    enabled: true
    minAvailable: 1
```

## Related Documentation

- **[Chart Values](values.yaml)** - Default values
- **[../README.md](../README.md)** - Global parameters and overview
- **[../../deployments/README.md](../../deployments/README.md)** - Deployment configuration guide

## Next Steps

1. **Configure:** Create deployment values in `../../deployments/myclient-prod/values.yaml`
2. **Deploy:** Use ArgoCD GitOps or manual Helm install
3. **Access:** Frontend will be available at `provider.{global.domain}`
