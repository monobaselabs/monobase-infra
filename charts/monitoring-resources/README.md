# Monitoring Resources Helm Chart

Grafana Dashboards, Prometheus Rules, and ServiceMonitors for monobase-infra monitoring stack.

## Overview

This chart deploys monitoring resources that complement the Prometheus + Grafana monitoring stack:

- **Grafana Dashboards**: Pre-configured dashboards (cluster, API, database)
- **Prometheus Rules**: Alert rules for critical infrastructure components
- **ServiceMonitors**: Prometheus scrape configurations for services

## Prerequisites

- Prometheus Operator installed (creates PrometheusRule and ServiceMonitor CRDs)
- Grafana with sidecar enabled (auto-loads dashboards from ConfigMaps)

## Installation

```bash
# Install with default values
helm install monitoring-resources ./charts/monitoring-resources

# Customize namespace
helm install monitoring-resources ./charts/monitoring-resources \
  --set namespace=custom-monitoring

# Enable only specific dashboards
helm install monitoring-resources ./charts/monitoring-resources \
  --set dashboards.cluster.enabled=true \
  --set dashboards.api.enabled=false
```

## Configuration

### Key Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `namespace` | Namespace for monitoring resources | `monitoring` |
| `dashboards.enabled` | Enable Grafana dashboards | `true` |
| `dashboards.readme.enabled` | Enable README dashboard | `true` |
| `dashboards.cluster.enabled` | Enable cluster overview dashboard | `true` |
| `dashboards.api.enabled` | Enable API performance dashboard | `true` |
| `dashboards.database.enabled` | Enable database dashboard | `true` |
| `rules.enabled` | Enable Prometheus alert rules | `true` |
| `serviceMonitors.enabled` | Enable ServiceMonitors | `true` |

See [values.yaml](values.yaml) for full configuration options.

## Components

### Grafana Dashboards

Dashboards are automatically discovered by Grafana sidecar via ConfigMaps with label `grafana_dashboard="1"`.

- **README Dashboard**: Getting started guide with links to community dashboards
- **Cluster Overview**: Node and pod metrics
- **API Performance**: Monobase API latency and throughput
- **Database Performance**: PostgreSQL metrics

### Prometheus Rules

Alert rules for infrastructure health monitoring:

- Critical alerts: Node down, high memory usage, disk space low
- Warning alerts: High CPU, pod restart loops

### ServiceMonitors

Prometheus scrape configurations for:

- Monobase API `/metrics` endpoint
- PostgreSQL exporter
- Envoy Gateway metrics

## Usage with ArgoCD

Deployed automatically via ArgoCD when `monitoring.enabled=true`:

```yaml
# charts/argocd-infrastructure/templates/monitoring-resources.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: monitoring-resources
spec:
  source:
    chart: monitoring-resources
    path: charts/monitoring-resources
  helm:
    values: |
      namespace: {{ .Values.monitoring.namespace }}
```

## Development

```bash
# Lint chart
helm lint ./charts/monitoring-resources

# Dry-run
helm install --dry-run --debug monitoring-resources ./charts/monitoring-resources

# Template
helm template monitoring-resources ./charts/monitoring-resources
```
