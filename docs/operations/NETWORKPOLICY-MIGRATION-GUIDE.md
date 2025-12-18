# NetworkPolicy Migration Guide: Centralized to Hybrid Architecture

## Overview

This guide documents the migration from fully centralized NetworkPolicies to a hybrid architecture where:
- **Namespace-wide security baseline** remains centralized (platform responsibility)
- **Application-specific network rules** move to individual charts (app responsibility)

## Migration Goals

1. ✅ Make application charts more portable and self-contained
2. ✅ Follow industry conventions (Bitnami, Helm best practices)
3. ✅ Maintain security-first deployment model
4. ✅ Clear separation of concerns (platform vs application)
5. ✅ Preserve multi-tenant isolation capabilities

## Architecture Changes

### Before (Fully Centralized)

```
charts/security-baseline/
├── default-deny-all.yaml           # Namespace foundation
├── deny-cross-namespace.yaml       # Multi-tenant isolation
├── allow-gateway-to-apps.yaml      # Gateway → All apps
├── allow-apps-to-db.yaml           # API → PostgreSQL
└── allow-apps-to-storage.yaml      # API → MinIO, Typesense
```

**Deployment:** Single chart deployed once per namespace (sync wave 0)

### After (Hybrid)

```
charts/security-baseline/
├── default-deny-all.yaml           # ✅ KEEP - Namespace foundation
└── deny-cross-namespace.yaml       # ✅ KEEP - Multi-tenant isolation

charts/api/templates/
└── networkpolicy.yaml              # ✨ NEW - API ingress + egress

charts/postgresql/
└── values.yaml                     # ✨ ENABLE - Bitnami NetworkPolicy

charts/minio/
└── values.yaml                     # ✨ ENABLE - Bitnami NetworkPolicy

charts/{account,patient,provider,website}/templates/
└── networkpolicy.yaml              # ✨ NEW - Frontend ingress
```

**Deployment:**
- security-baseline (sync wave 0) - namespace foundation
- App charts (sync wave 2-3) - app-specific rules deployed with apps

## Detailed Implementation Plan

### Phase 1: Add Per-Chart NetworkPolicies (Additive)

#### 1.1 API Chart NetworkPolicy

**File:** `charts/api/templates/networkpolicy.yaml`

**Current State:** Skeleton template with no rules

**Required Changes:**
```yaml
{{- if .Values.networkPolicy.enabled }}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "api.fullname" . }}
  namespace: {{ .Values.global.namespace }}
  labels:
    {{- include "api.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "api.selectorLabels" . | nindent 6 }}
  policyTypes:
    - Ingress
    - Egress

  # Ingress: Allow from Gateway
  ingress:
    - from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: {{ .Values.networkPolicy.gateway.namespace }}
        podSelector:
          matchLabels:
            app.kubernetes.io/name: {{ .Values.networkPolicy.gateway.name }}
      ports:
        - protocol: TCP
          port: {{ .Values.service.port }}

  # Egress: Allow to PostgreSQL, MinIO, Typesense, DNS, K8s API, HTTPS
  egress:
    # PostgreSQL database
    - to:
      - podSelector:
          matchLabels:
            app.kubernetes.io/name: postgresql
            app.kubernetes.io/component: primary
      ports:
        - protocol: TCP
          port: 5432

    # MinIO storage
    - to:
      - podSelector:
          matchLabels:
            app.kubernetes.io/name: minio
      ports:
        - protocol: TCP
          port: 9000

    # Typesense search (if enabled)
    {{- if .Values.networkPolicy.typesense.enabled }}
    - to:
      - podSelector:
          matchLabels:
            app.kubernetes.io/name: typesense
      ports:
        - protocol: TCP
          port: 8108
    {{- end }}

    # DNS resolution
    - to:
      - namespaceSelector: {}
        podSelector:
          matchLabels:
            k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53

    # Kubernetes API server
    - to:
      - namespaceSelector: {}
        podSelector:
          matchLabels:
            component: apiserver
      ports:
        - protocol: TCP
          port: 443

    # HTTPS egress (external APIs, SMTP via TLS)
    - to:
      - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 443
        - protocol: TCP
          port: 587  # SMTP TLS
{{- end }}
```

**File:** `charts/api/values.yaml`

**Add Section:**
```yaml
# NetworkPolicy configuration
networkPolicy:
  enabled: true  # Enable by default for security
  gateway:
    namespace: envoy-gateway-system
    name: envoy-gateway
  typesense:
    enabled: false  # Enable if typesense is deployed
```

---

#### 1.2 PostgreSQL Chart NetworkPolicy

**File:** `charts/postgresql/values.yaml`

**Current State:** Bitnami chart with NetworkPolicy disabled

**Required Changes:**
```yaml
postgresql:
  # ... existing config ...

  # Enable NetworkPolicy (Bitnami chart feature)
  networkPolicy:
    enabled: true

    # Don't allow external connections (only from API within namespace)
    allowExternal: false

    # Allow connections from API pods
    ingressRules:
      primaryAccessOnlyFrom:
        enabled: true
        namespaceSelector: {}  # Same namespace
        podSelector:
          matchLabels:
            app.kubernetes.io/name: api

      # Allow metrics scraping by Prometheus
      customRules:
        - from:
          - namespaceSelector:
              matchLabels:
                kubernetes.io/metadata.name: monitoring
            podSelector:
              matchLabels:
                app.kubernetes.io/name: prometheus
          ports:
            - protocol: TCP
              port: 9187  # PostgreSQL exporter port
```

**Note:** Bitnami PostgreSQL chart includes comprehensive NetworkPolicy templates. We're enabling and configuring them.

---

#### 1.3 MinIO Chart NetworkPolicy

**File:** `charts/minio/values.yaml`

**Current State:** Bitnami chart with NetworkPolicy disabled

**Required Changes:**
```yaml
minio:
  # ... existing config ...

  # Enable NetworkPolicy (Bitnami chart feature)
  networkPolicy:
    enabled: true

    # Don't allow external connections (only from API and Gateway)
    allowExternal: false

    # Allow connections from API and Gateway
    ingressRules:
      - from:
        - namespaceSelector: {}  # Same namespace
          podSelector:
            matchLabels:
              app.kubernetes.io/name: api
        ports:
          - protocol: TCP
            port: 9000

      - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: envoy-gateway-system
          podSelector:
            matchLabels:
              app.kubernetes.io/name: envoy-gateway
        ports:
          - protocol: TCP
            port: 9000

      # Allow metrics scraping
      - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app.kubernetes.io/name: prometheus
        ports:
          - protocol: TCP
            port: 9000
```

---

#### 1.4 Frontend Apps NetworkPolicy

**Files:**
- `charts/account/templates/networkpolicy.yaml`
- `charts/patient/templates/networkpolicy.yaml`
- `charts/provider/templates/networkpolicy.yaml`
- `charts/website/templates/networkpolicy.yaml`

**Current State:** Skeleton templates with no rules

**Required Changes (same for all frontends):**
```yaml
{{- if .Values.networkPolicy.enabled }}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "account.fullname" . }}  # Change per chart
  namespace: {{ .Values.global.namespace }}
  labels:
    {{- include "account.labels" . | nindent 4 }}  # Change per chart
spec:
  podSelector:
    matchLabels:
      {{- include "account.selectorLabels" . | nindent 6 }}  # Change per chart
  policyTypes:
    - Ingress
    - Egress

  # Ingress: Allow from Gateway only
  ingress:
    - from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: {{ .Values.networkPolicy.gateway.namespace }}
        podSelector:
          matchLabels:
            app.kubernetes.io/name: {{ .Values.networkPolicy.gateway.name }}
      ports:
        - protocol: TCP
          port: {{ .Values.service.port }}

  # Egress: Minimal (frontends are static, may need CDN/analytics)
  egress:
    # DNS resolution
    - to:
      - namespaceSelector: {}
        podSelector:
          matchLabels:
            k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53

    # HTTPS egress (for CDN, analytics, external assets)
    - to:
      - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 443
{{- end }}
```

**Add to values.yaml for each:**
```yaml
networkPolicy:
  enabled: true
  gateway:
    namespace: envoy-gateway-system
    name: envoy-gateway
```

---

### Phase 2: Remove Redundant Centralized Policies

#### 2.1 Remove from security-baseline

**Files to DELETE:**
- `charts/security-baseline/templates/allow-gateway-to-apps.yaml`
- `charts/security-baseline/templates/allow-apps-to-db.yaml`
- `charts/security-baseline/templates/allow-apps-to-storage.yaml`

**Files to KEEP:**
- `charts/security-baseline/templates/default-deny-all.yaml`
- `charts/security-baseline/templates/deny-cross-namespace.yaml`

**Update Chart.yaml:**
```yaml
# charts/security-baseline/Chart.yaml
apiVersion: v2
name: security-baseline
description: Namespace-wide security baseline (default-deny, cross-namespace isolation)
type: application
version: 2.0.0  # Bump major version (breaking change)
appVersion: "2.0"
```

**Update README:**
```yaml
# charts/security-baseline/README.md
# Security Baseline Chart

Provides namespace-wide security foundation:
- Default-deny NetworkPolicies (all ingress/egress blocked by default)
- Cross-namespace isolation (prevents lateral movement)

Application-specific NetworkPolicies are now defined in individual application charts.
```

---

### Phase 3: Testing Plan

#### 3.1 Pre-Deployment Testing (Local)

**Render templates to verify syntax:**
```bash
# Test API chart
helm template api charts/api --values values/deployments/acme-staging.yaml

# Test PostgreSQL chart
helm template postgresql charts/postgresql --values values/deployments/acme-staging.yaml

# Test security-baseline chart
helm template security-baseline charts/security-baseline --values values/deployments/acme-staging.yaml
```

**Expected Output:**
- API: NetworkPolicy resource with ingress + egress rules
- PostgreSQL: NetworkPolicy resource with ingress rules
- security-baseline: Only default-deny and deny-cross-namespace policies

#### 3.2 Staging Deployment

**Step 1: Deploy with BOTH policies active (additive test)**
```bash
# Current state: Centralized policies active
# Deploy updated charts: Per-chart policies will be created
# NetworkPolicies are additive (allow rules combine)
# This should NOT break connectivity

git add -A
git commit -m "feat: add per-chart NetworkPolicies (additive)"
git push
# Wait for ArgoCD to sync
```

**Step 2: Verify connectivity**
```bash
# Test Gateway → API
kubectl exec -n envoy-gateway-system <gateway-pod> -- curl http://api.acme-staging:7213/health

# Test API → PostgreSQL
kubectl exec -n acme-staging <api-pod> -- pg_isready -h postgresql -p 5432

# Test API → MinIO
kubectl exec -n acme-staging <api-pod> -- curl http://minio:9000/minio/health/live

# Test Gateway → Frontend
kubectl exec -n envoy-gateway-system <gateway-pod> -- curl http://account.acme-staging:3000
```

**Step 3: Remove centralized policies**
```bash
# Delete redundant policies from security-baseline
git add charts/security-baseline/
git commit -m "refactor: remove app-specific policies from security-baseline"
git push
# Wait for ArgoCD to sync
```

**Step 4: Re-verify connectivity**
```bash
# Run same tests as Step 2
# All should still work (now using per-chart policies)
```

#### 3.3 Production Deployment

**Prerequisites:**
- ✅ Staging tests passed
- ✅ All connectivity verified
- ✅ NetworkPolicy resources reviewed

**Rollout Plan:**
1. Deploy to production with BOTH policies active (safe, additive)
2. Monitor for 24-48 hours
3. Remove centralized policies after verification period
4. Document new architecture

---

### Phase 4: Documentation Updates

#### 4.1 Update Architecture Docs

**File:** `docs/architecture/GITOPS-ARGOCD.md`

**Add Section:**
```markdown
### NetworkPolicy Architecture

**Hybrid Approach:**
- **Centralized baseline** (`charts/security-baseline`): Namespace-wide default-deny and cross-namespace isolation
- **Per-application policies** (`charts/*/templates/networkpolicy.yaml`): App-specific ingress/egress rules

**Deployment Order:**
- Wave 0: security-baseline (namespace foundation)
- Wave 2-3: Applications (with their NetworkPolicies)

**Rationale:**
- Platform team manages namespace security baseline
- Application teams own app-specific network rules
- Each chart is portable and self-contained
- Follows industry conventions (Bitnami, Helm)
```

#### 4.2 Update Security Hardening Guide

**File:** `docs/security/SECURITY-HARDENING.md`

**Update NetworkPolicy Section:**
```markdown
## NetworkPolicy Configuration

### Centralized Baseline (Platform Responsibility)

Location: `charts/security-baseline/`

Provides namespace-wide security foundation:
- `default-deny-all.yaml`: Blocks all traffic by default
- `deny-cross-namespace.yaml`: Prevents lateral movement between namespaces

Deployed: Sync wave 0 (before applications)

### Per-Application Policies (Application Responsibility)

Each application defines its own network requirements:
- **API** (`charts/api/templates/networkpolicy.yaml`): Ingress from gateway, egress to DB/storage/HTTPS
- **PostgreSQL** (`charts/postgresql/values.yaml`): Ingress from API only
- **MinIO** (`charts/minio/values.yaml`): Ingress from API and gateway
- **Frontends** (`charts/{account,patient,provider,website}/templates/networkpolicy.yaml`): Ingress from gateway

### Testing NetworkPolicies

Test connectivity between pods:
```bash
# Gateway → API
kubectl exec -n envoy-gateway-system <gateway-pod> -- curl http://api.<namespace>:7213/health

# API → PostgreSQL
kubectl exec -n <namespace> <api-pod> -- pg_isready -h postgresql -p 5432
```

Verify blocking:
```bash
# Cross-namespace should be blocked
kubectl exec -n namespace-a <pod> -- curl http://api.namespace-b:7213  # Should timeout
```
```

#### 4.3 Add Migration Document

**File:** `docs/operations/NETWORKPOLICY-MIGRATION.md` (this file)

Already created! Reference this guide for future migrations.

---

## Rollback Plan

If issues occur during migration:

### Rollback Step 1: Re-add Centralized Policies

```bash
git revert <commit-hash>  # Revert removal of centralized policies
git push
# ArgoCD will re-deploy centralized policies
```

### Rollback Step 2: Disable Per-Chart Policies

**Quick Fix:**
```yaml
# In values/deployments/*.yaml
api:
  networkPolicy:
    enabled: false

# For PostgreSQL and MinIO
postgresql:
  networkPolicy:
    enabled: false

minio:
  networkPolicy:
    enabled: false
```

**Full Rollback:**
```bash
git revert <commit-hash>  # Revert per-chart NetworkPolicy additions
git push
```

---

## Validation Checklist

- [ ] All chart templates render without errors
- [ ] security-baseline only contains default-deny and cross-namespace policies
- [ ] API chart includes NetworkPolicy with ingress + egress rules
- [ ] PostgreSQL NetworkPolicy enabled with ingress rules
- [ ] MinIO NetworkPolicy enabled with ingress rules
- [ ] Frontend charts include NetworkPolicy with ingress rules
- [ ] Staging deployment successful with both policies active
- [ ] Connectivity tests passed in staging
- [ ] Centralized policies removed from staging
- [ ] Re-verification of connectivity in staging
- [ ] Production deployment planned and scheduled
- [ ] Documentation updated
- [ ] Team trained on new architecture

---

## Timeline Estimate

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1: Add per-chart policies | 2-3 days | Template creation, testing |
| Phase 2: Remove centralized policies | 1 day | Phase 1 complete, staging verified |
| Phase 3: Testing | 3-5 days | Staging deployment, connectivity tests |
| Phase 4: Documentation | 1-2 days | Can parallelize with Phase 1-2 |
| **Total** | **1-2 weeks** | - |

---

## Success Criteria

1. ✅ All applications have NetworkPolicy resources deployed with them
2. ✅ security-baseline contains only namespace-wide policies
3. ✅ All connectivity tests pass (gateway→apps, api→db, api→storage)
4. ✅ Cross-namespace isolation still enforced
5. ✅ Each application chart is portable and self-contained
6. ✅ Documentation updated and team trained
7. ✅ Zero downtime during migration

---

## References

- [Bitnami PostgreSQL NetworkPolicy](https://github.com/bitnami/charts/tree/main/bitnami/postgresql#network-policy)
- [Bitnami MinIO NetworkPolicy](https://github.com/bitnami/charts/tree/main/bitnami/minio#network-policy)
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Helm Chart Best Practices](https://helm.sh/docs/chart_best_practices/)
