# Gateway API Guide

Envoy Gateway configuration, HTTPRoute management, and zero-downtime routing.

## Shared Gateway Strategy

**Key Architecture Decision:** 1 Shared Gateway + Dynamic HTTPRoutes

**Benefits:**
- ✅ Zero-downtime client onboarding (add HTTPRoute, no Gateway restart)
- ✅ Single LoadBalancer IP (cost-effective)
- ✅ Clean namespace isolation
- ✅ Flexible hostname management

## Gateway Configuration

### Shared Gateway (Automatic Deployment)

The Gateway is deployed **automatically by ArgoCD** during bootstrap.

**What gets created:**
- ✅ `shared-gateway` Gateway resource in `gateway-system` namespace
- ✅ Wildcard TLS certificate (`wildcard-tls`) via cert-manager
- ✅ HTTP to HTTPS redirect
- ✅ LoadBalancer service (created by Envoy Gateway)

**Configuration:** `infrastructure/gateway/shared-gateway.yaml` (managed via GitOps)

**Reference example:**

```yaml
# Example Gateway configuration
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: shared-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: "*.myclient.com"  # Wildcard
      allowedRoutes:
        namespaces:
          from: All  # Allow routes from any namespace
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-tls
```

**Why single listener?**
- HTTPRoutes specify exact hostnames
- Gateway accepts all via wildcard
- Adding clients = adding HTTPRoutes (no Gateway change)

### Get LoadBalancer IP

```bash
kubectl get gateway shared-gateway -n gateway-system \\
  -o jsonpath='{.status.addresses[0].value}'
```

## HTTPRoute Management

### Create HTTPRoute for Service

```yaml
# Per application (in charts/*/templates/httproute.yaml)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api
  namespace: myclient-prod
spec:
  parentRefs:
    - name: shared-gateway
      namespace: gateway-system
  hostnames:
    - api.myclient.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: api
          port: 7500
```

### List All Routes

```bash
# All HTTPRoutes across namespaces
kubectl get httproute -A

# Routes for specific client
kubectl get httproute -n myclient-prod

# Route details
kubectl describe httproute api -n myclient-prod
```

### Route Status

```bash
# Check if route is accepted
kubectl get httproute api -n myclient-prod \\
  -o jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}'
# Should return: True

# Check route programmed
kubectl get httproute api -n myclient-prod \\
  -o jsonpath='{.status.parents[0].conditions[?(@.type=="Programmed")].status}'
# Should return: True
```

## Adding New Client (Zero-Downtime)

### Steps

```bash
# 1. Client creates their HTTPRoute
kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api
  namespace: client-c-prod  # New client
spec:
  parentRefs:
    - name: shared-gateway
      namespace: gateway-system
  hostnames:
    - api.client-c.com
  rules:
    - backendRefs:
        - name: api
          port: 7500
EOF

# 2. HTTPRoute added dynamically (xDS)
# ✅ NO Gateway restart
# ✅ NO existing client impact
# ✅ New route available immediately

# 3. Verify
kubectl get httproute -n client-c-prod
curl https://api.client-c.com/health
```

**Impact on Existing Clients:** ZERO!

## Advanced Routing

### Path-Based Routing

```yaml
rules:
  - matches:
      - path:
          type: PathPrefix
          value: /api/v1
    backendRefs:
      - name: api-v1
        port: 7500
  
  - matches:
      - path:
          type: PathPrefix
          value: /api/v2
    backendRefs:
      - name: api-v2
        port: 7500
```

### Header-Based Routing

```yaml
rules:
  - matches:
      - headers:
          - name: X-API-Version
            value: "2.0"
    backendRefs:
      - name: api-v2
        port: 7500
```

### Weighted Traffic Splitting (Canary)

```yaml
rules:
  - backendRefs:
      - name: api-stable
        port: 7500
        weight: 90  # 90% traffic
      - name: api-canary
        port: 7500
        weight: 10  # 10% traffic
```

## TLS Configuration

### Wildcard Certificate (Recommended)

```yaml
# Single cert for *.myclient.com
tls:
  mode: Terminate
  certificateRefs:
    - name: wildcard-tls-myclient-com
      namespace: gateway-system

# cert-manager creates automatically via Gateway annotation
```

### Per-Route Certificate

```yaml
# HTTPRoute-specific certificate
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
spec:
  parentRefs:
    - name: shared-gateway
      namespace: gateway-system
      port: 443
  rules:
    - backendRefs:
        - name: api
          port: 7500
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            set:
              - name: X-Forwarded-Proto
                value: https
```

## Troubleshooting

### HTTPRoute Not Working

```bash
# Check route status
kubectl describe httproute api -n myclient-prod

# Common issues:
# 1. Gateway not ready
kubectl get gateway shared-gateway -n gateway-system

# 2. Backend service not found
kubectl get svc api -n myclient-prod

# 3. Wrong namespace (ReferenceGrant needed for cross-namespace)

# 4. Hostname conflicts (multiple routes same hostname)
kubectl get httproute -A | grep api.myclient.com
```

### Gateway Not Getting LoadBalancer IP

```bash
# Check Gateway status
kubectl describe gateway shared-gateway -n gateway-system

# Check Envoy deployment
kubectl get pods -n gateway-system

# Check LoadBalancer service
kubectl get svc -n gateway-system

# Cloud-specific:
# AWS: Check security groups, subnets
# Azure: Check NSG, load balancer quota
# GCP: Check firewall rules
```

## Summary

**Gateway API provides:**
- ✅ Modern, Kubernetes-native routing
- ✅ Zero-downtime client onboarding
- ✅ Flexible traffic management
- ✅ Built-in TLS support
- ✅ Cost-effective (single LoadBalancer)

**Deployment:** 
- Envoy Gateway operator: `argocd/infrastructure/templates/envoy-gateway.yaml` (sync wave 0)
- Gateway resource: `argocd/infrastructure/templates/gateway-resources.yaml` (sync wave 1)
- Configuration: `infrastructure/gateway/shared-gateway.yaml` (GitOps-managed)

**Reference examples:** See `docs/components/envoy-gateway-*.yaml` and `infrastructure/gateway/` for configuration
