# ArgoCD Sync Status Guide

This document explains ArgoCD sync statuses in this cluster, particularly why certain applications show "OutOfSync" despite being healthy and properly configured.

## Understanding Sync Status vs Health Status

ArgoCD tracks two independent statuses for each Application:

- **Health Status**: Indicates if the application is running correctly
  - `Healthy`: All resources are functioning properly
  - `Progressing`: Resources are being created/updated
  - `Degraded`: Some resources have issues
  - `Missing`: Resources are missing

- **Sync Status**: Indicates if live state matches desired state in Git
  - `Synced`: Live cluster state matches Git
  - `OutOfSync`: Live cluster state differs from Git
  - `Unknown`: Cannot determine sync state

## The "Healthy + OutOfSync" Pattern

### What It Means

**"Healthy + OutOfSync" is the normal, expected state for applications managing resources with controller-managed status fields.**

This combination indicates:
- ✅ **Application is working correctly** (Healthy)
- ⚠️ **Some fields differ from Git** (OutOfSync)
- ✅ **The differences are in runtime status fields, NOT configuration**

### Why It Happens

Kubernetes controllers continuously update the `.status` subresource of Custom Resources to reflect current runtime state. These updates happen after ArgoCD syncs and are managed by controllers, not by your Git configuration.

Examples:
- **External Secrets Operator**: Updates `ExternalSecret.status` with sync time, conditions
- **Gateway Controller**: Updates `HTTPRoute.status` with parent refs, route status
- **Cert-Manager**: Updates `Certificate.status` with renewal info, conditions

## Applications Affected in This Cluster

The following applications are expected to show "Healthy + OutOfSync":

### 1. external-dns
- **Resource**: `ExternalSecret` (cloudflare-api-token)
- **Controller**: External Secrets Operator
- **Status Fields**: `refreshTime`, `conditions`, `syncedResourceVersion`
- **Update Frequency**: Every 1 hour (refresh interval)
- **Why OutOfSync**: Operator updates status after each secret refresh

### 2. grafana
- **Resource**: `HTTPRoute` (grafana route)
- **Controller**: Envoy Gateway Controller
- **Status Fields**: `parents`, `conditions`, `attachedRoutes`
- **Update Frequency**: On Gateway state changes
- **Why OutOfSync**: Controller updates status as gateway state changes

### 3. gateway-resources
- **Resources**: `Gateway`, `HTTPRoute`, `Certificate`
- **Controllers**: Envoy Gateway, cert-manager
- **Status Fields**: Various status subresources
- **Update Frequency**: Continuous
- **Why OutOfSync**: Multiple controllers updating status

## Our Configuration Strategy

We have properly configured `ignoreDifferences` to tell ArgoCD these status differences are acceptable:

```yaml
# Example from external-dns.yaml
ignoreDifferences:
  - group: external-secrets.io
    kind: ExternalSecret
    jsonPointers:
      - /status

syncOptions:
  - RespectIgnoreDifferences=true
```

### Why ignoreDifferences Doesn't Prevent OutOfSync

ArgoCD has known limitations with `ignoreDifferences` for CRD status subresources:
- **GitHub Issue #21308**: `ignoreDifferences` for CustomResource does not have effect
- **GitHub Issue #18344**: Server-Side Diff shows OutOfSync despite ignoreDifferences
- **Root Cause**: Status subresources are treated differently by ArgoCD's diffing logic

The configuration is correct, but ArgoCD's implementation has bugs that prevent it from fully working for CRD status fields.

## When to Investigate

### ✅ ACCEPTABLE - Ignore These

**Healthy + OutOfSync**
- Application is working correctly
- Only status fields differ
- Controllers are updating runtime state normally

**Example:**
```
NAME           HEALTH    SYNC
external-dns   Healthy   OutOfSync  ← This is fine!
```

### ⚠️ INVESTIGATE - Look Into These

**Degraded or Progressing + Any Sync**
- Application has actual issues
- Resources may not be deploying correctly

**Example:**
```
NAME           HEALTH       SYNC
external-dns   Degraded     Synced     ← Check this!
external-dns   Progressing  OutOfSync  ← Check this!
```

**OutOfSync with Configuration Files**
- If you see OutOfSync on resources OTHER than status fields
- Check the diff in ArgoCD UI to see what's different
- May indicate manual changes or configuration drift

## How to Check What's Different

1. **ArgoCD UI**: Navigate to Application → App Diff
   - Look for differences in `.status` fields (ignore these)
   - Look for differences in `.spec` or `.metadata` (investigate these)

2. **ArgoCD CLI**:
   ```bash
   argocd app diff <app-name>
   ```

3. **kubectl**:
   ```bash
   kubectl get application <app-name> -n argocd -o json | jq '.status.conditions'
   ```

## Alternative Solutions (Not Implemented)

We could make applications show "Synced" by using ArgoCD's global configuration:

```yaml
# Add to argocd-cm ConfigMap
data:
  resource.ignoreResourceStatusField: "crd"
```

**Why we don't use this:**
- Applies globally to ALL CRDs cluster-wide
- May hide legitimate status differences
- "Healthy + OutOfSync" is acceptable and doesn't cause issues
- Adds unnecessary global configuration complexity

## Summary

| Status Combination | Meaning | Action |
|-------------------|---------|--------|
| Healthy + Synced | Everything perfect | None needed |
| Healthy + OutOfSync | Working correctly, status fields differ | **Accept as normal** |
| Progressing + Any | Application deploying | Monitor until Healthy |
| Degraded + Any | Application has issues | **Investigate immediately** |
| Missing + Any | Resources deleted/missing | **Investigate immediately** |

## Key Takeaways

1. **Focus on Health status**, not Sync status for operational health
2. **"Healthy + OutOfSync" is normal** for apps with controller-managed resources
3. **Our ignoreDifferences configuration is correct**, ArgoCD has known bugs
4. **Only investigate when Health shows Degraded/Progressing/Missing**
5. **This is a common pattern** accepted by many ArgoCD users

---

**Last Updated**: 2025-11-26
**Related Issues**:
- [ArgoCD #21308](https://github.com/argoproj/argo-cd/issues/21308)
- [ArgoCD #18344](https://github.com/argoproj/argo-cd/issues/18344)
- [ArgoCD #9678](https://github.com/argoproj/argo-cd/issues/9678)
