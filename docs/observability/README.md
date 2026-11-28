---
description: "Grafana dashboards, Prometheus alert rules and collector settings for iHub's telemetry."
audience: admin
type: how-to
---

# Dashboards, Alerts and Collector Setup

Ready-made artifacts for the metrics and traces described in [Telemetry](../telemetry.md):

| File | What it is |
| --- | --- |
| `dashboards/ihub-llm.json` | LLM calls per provider, model and endpoint: latency, time to first chunk, errors, 429s, in-flight and queued calls, tokens, prompt-cache share |
| `dashboards/ihub-turns-tools.json` | Whole turns by surface, outcome and app; tool durations and outcomes; workflow executions, node durations, human-in-the-loop waits |
| `dashboards/ihub-auth-security.json` | Sign-ins by provider and outcome, token validation, security events, identity provider availability |
| `dashboards/ihub-capacity.json` | Version and telemetry export status, event loop, memory, file descriptors, disk per storage location, dependencies, TLS errors, locks, cluster bus, extraction queue |
| `dashboards/ihub-product.json` | Active users and chats, turns by client channel and surface, top apps, feedback by model, answer basis |
| `alerts/ihub-alerts.yaml` | Prometheus alert rules (also usable as a `PrometheusRule`) |

## Import the dashboards

In Grafana: **Dashboards → New → Import**, upload a JSON file and pick the Prometheus (or Mimir)
data source. Each dashboard has a `datasource` and a `job` variable. The queries use the metric
names of iHub's built-in Prometheus endpoint (no unit suffix: `gen_ai_client_operation_duration`).
When metrics reach Mimir or Prometheus through OTLP, the collector's translation usually appends
the unit (`gen_ai_client_operation_duration_seconds`); replace the names in the JSON if yours does.

Across cluster workers, counters and histograms are summed and the cluster-wide gauges take the
`max` (see [Telemetry → Cluster mode](../telemetry.md#cluster-mode)); the dashboards already do.

## Apply the alert rules

```bash
# Plain Prometheus: reference the file in prometheus.yml
rule_files:
  - /etc/prometheus/rules/ihub-alerts.yaml

# prometheus-operator: wrap the groups (see the header of the file)
kubectl apply -f ihub-prometheusrule.yaml
```

The rules cover: no metrics at all (`absent(ihub_build_info)`), stale or failing telemetry exports,
LLM error ratio above 5 % per provider, provider 429s, slow time to first chunk, the turn latency
SLO, failing or empty turns, stream errors, login-failure spikes and missing logins, the identity
provider down, event-loop delay p99 above 200 ms, memory near the container limit, a volume more
than 85 % full, a dependency down, TLS errors, a slow extraction queue and config reload errors.
Thresholds are starting points.

## Collector settings

### Attributes to drop

iHub sets a stable `service.instance.id` (`<host>-w<worker>`) and does not detect the process id
or command line. Other SDKs or older iHub versions may still send them. With
`resource_to_telemetry_conversion` every resource attribute becomes a metric label, so drop the
ones that change on every restart before the conversion, or each rollout creates a new series set
and Mimir runs into its series limit:

```alloy
otelcol.processor.resource "drop_churn" {
  attributes {
    action = "delete"
    key    = "process.pid"
  }
  attributes {
    action = "delete"
    key    = "process.command_args"
  }
  attributes {
    action  = "delete"
    pattern = "host\\..*"
  }
  output {
    metrics = [otelcol.exporter.prometheus.mimir.input]
  }
}
```

Keep `host.*` on traces if you want them there; drop it on the metrics path only.

### Tail sampling

Head sampling (`telemetry.spans.sampleRate`) decides before anything is known about a trace. To
keep every failed and every slow trace while storing a fraction of the rest, leave `sampleRate`
at 1 and sample in the collector:

```alloy
otelcol.processor.tail_sampling "ihub" {
  decision_wait = "30s"

  policy {
    name = "errors"
    type = "status_code"
    status_code { status_codes = ["ERROR"] }
  }
  policy {
    name = "slow-turns"
    type = "latency"
    latency { threshold_ms = 20000 }
  }
  policy {
    name = "baseline"
    type = "probabilistic"
    probabilistic { sampling_percentage = 10 }
  }

  output {
    traces = [otelcol.exporter.otlp.tempo.input]
  }
}
```

Tail sampling needs all spans of a trace on the same collector instance. With several collector
replicas, put a `loadbalancing` exporter keyed on the trace id in front of them.

### Private CA and mutual TLS

The OTLP exporters use the platform's outbound settings: a collector whose host is on
`ssl.domainWhitelist` may use a certificate from a private CA, and the proxy settings apply. For a
CA bundle or a client certificate, set `OTEL_EXPORTER_OTLP_CERTIFICATE`,
`OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` and `OTEL_EXPORTER_OTLP_CLIENT_KEY` (or the
`_TRACES_` / `_METRICS_` / `_LOGS_` variants). gRPC is not supported; use the collector's HTTP
receiver (port 4318).

### Air-gapped installations

Everything works without internet access: point `exporters.otlp.endpoint` at a collector inside
the network, or scrape the Prometheus endpoint. The dashboards and rules have no external
dependencies.

## Retention and tenants

Traces carry pseudonymised users and hashed conversation ids by default (see
[PII Data Handling](../pii-data-handling.md)). Treat the trace backend as pseudonymous personal
data: keep trace retention short (7–14 days is usually enough to investigate an incident), keep
metrics longer, and do not grant broad read access to the tenant iHub writes to. In a shared
Tempo / Mimir / Loki, give iHub its own tenant (`X-Scope-OrgID` as an OTLP header, which iHub stores
encrypted).
