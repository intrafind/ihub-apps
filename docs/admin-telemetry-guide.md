# Telemetry Configuration Guide for Administrators

**Last Updated:** 2026-01-21  
**Audience:** System Administrators, DevOps Engineers

---

## Overview

iHub Apps includes comprehensive OpenTelemetry instrumentation for monitoring LLM operations, tracking app usage, and analyzing system performance. This guide explains how to configure and use the telemetry features.

---

## Quick Start

### Enable Telemetry

Edit `contents/config/platform.json`:

```json
{
  "telemetry": {
    "enabled": true,
    "provider": "console"
  }
}
```

Restart the server:
```bash
npm run server
```

---

## Configuration Options

### Complete Configuration Schema

```json
{
  "telemetry": {
    "enabled": true,
    "provider": "console|otlp|prometheus",
    
    "exporters": {
      "otlp": {
        "endpoint": "http://localhost:4318",
        "protocol": "http/protobuf",
        "headers": {
          "authorization": "Bearer YOUR_TOKEN"
        }
      },
      "prometheus": {
        "port": 9464,
        "host": "0.0.0.0"
      }
    },
    
    "spans": {
      "enabled": true,
      "sampleRate": 1.0,
      "includeOptInAttributes": false
    },
    
    "events": {
      "enabled": true,
      "includePrompts": false,
      "includeCompletions": false,
      "maxEventSize": 1024
    },
    
    "metrics": {
      "enabled": true,
      "exportInterval": 60000
    },
    
    "logs": {
      "enabled": false,
      "level": "info"
    },
    
    "resource": {
      "service.name": "ihub-apps",
      "service.version": "auto",
      "deployment.environment": "production"
    }
  }
}
```

### Configuration Fields

#### `enabled` (boolean)
- **Default:** `false`
- **Description:** Master switch for telemetry. Set to `true` to enable.

#### `provider` (string)
- **Options:** `console`, `otlp`, `prometheus`
- **Default:** `console`
- **Description:** Telemetry backend to use
  - `console` - Logs to server console (development)
  - `otlp` - OpenTelemetry Protocol (Jaeger, Grafana Cloud, etc.)
  - `prometheus` - Prometheus metrics exporter

#### `exporters.otlp`
- **`endpoint`** - OTLP receiver URL (e.g., `http://localhost:4318`)
- **`protocol`** - Protocol type (default: `http/protobuf`)
- **`headers`** - Custom headers (e.g., authentication tokens)

#### `exporters.prometheus`
- **`port`** - Port for Prometheus scraping (default: `9464`)
- **`host`** - Host to bind (default: `0.0.0.0`)

#### `spans.enabled` (boolean)
- **Default:** `true`
- **Description:** Enable distributed tracing spans

#### `spans.sampleRate` (number)
- **Range:** `0.0` to `1.0`
- **Default:** `1.0`
- **Description:** Percentage of traces to sample (e.g., `0.1` = 10%)

#### `spans.includeOptInAttributes` (boolean)
- **Default:** `false`
- **⚠️ WARNING:** Includes full message content (may contain PII)
- **Description:** Include prompt/completion content in spans

#### `events.enabled` (boolean)
- **Default:** `true`
- **Description:** Enable telemetry events

#### `events.includePrompts` (boolean)
- **Default:** `false`
- **⚠️ WARNING:** Logs user prompts (may contain PII)

#### `events.includeCompletions` (boolean)
- **Default:** `false`
- **⚠️ WARNING:** Logs AI responses (may contain sensitive data)

#### `events.maxEventSize` (number)
- **Default:** `1024`
- **Description:** Maximum event content size in characters

#### `metrics.enabled` (boolean)
- **Default:** `true`
- **Description:** Enable metric recording

#### `metrics.exportInterval` (number)
- **Default:** `60000`
- **Description:** Metric export interval in milliseconds

---

## Environment Variables

You can also configure telemetry via environment variables:

```bash
# Enable OTLP exporter
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer YOUR_TOKEN"

# Service identification
export OTEL_SERVICE_NAME=ihub-apps
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production,service.version=4.2.0"

# Sampling
export OTEL_TRACES_SAMPLER=parentbased_traceidratio
export OTEL_TRACES_SAMPLER_ARG=1.0
```

**Note:** Environment variables override `platform.json` settings.

---

## Available Metrics

### Gen-AI Metrics (OpenTelemetry Standard)

#### `gen_ai.client.token.usage`
- **Type:** Histogram
- **Unit:** `{token}`
- **Description:** Token usage per request
- **Dimensions:**
  - `gen_ai.provider.name` - Provider (openai, anthropic, google, mistral)
  - `gen_ai.operation.name` - Operation type (chat, generate_content)
  - `gen_ai.request.model` - Model name
  - `gen_ai.token.type` - Token type (input, output)

**Example Query (PromQL):**
```promql
# Total tokens by model
sum by (gen_ai_request_model, gen_ai_token_type) (gen_ai_client_token_usage_sum)

# Input tokens in last hour
increase(gen_ai_client_token_usage_sum{gen_ai_token_type="input"}[1h])
```

#### `gen_ai.client.operation.duration`
- **Type:** Histogram
- **Unit:** `s` (seconds)
- **Description:** LLM operation latency
- **Dimensions:**
  - `gen_ai.provider.name`
  - `gen_ai.operation.name`
  - `gen_ai.request.model`
  - `error.type` - Error type if failed

**Example Query (PromQL):**
```promql
# P95 latency by model
histogram_quantile(0.95, sum by (le, gen_ai_request_model) (gen_ai_client_operation_duration_bucket))

# Average latency per provider
avg by (gen_ai_provider_name) (gen_ai_client_operation_duration_sum / gen_ai_client_operation_duration_count)
```

### iHub-Specific Metrics

#### `ihub.app.usage`
- **Type:** Counter
- **Unit:** `{request}`
- **Description:** App usage count
- **Dimensions:**
  - `app.id` - Application ID
  - `user.id` - User ID (if available)

**Example Query (PromQL):**
```promql
# Top 10 most used apps
topk(10, sum by (app_id) (ihub_app_usage_total))

# Usage per user
sum by (user_id) (ihub_app_usage_total)
```

#### `ihub.prompt.usage`
- **Type:** Counter
- **Unit:** `{request}`
- **Description:** Prompt template usage
- **Dimensions:**
  - `prompt.id` - Prompt template ID
  - `app.id` - Associated app

**Example Query (PromQL):**
```promql
# Most popular prompts
topk(5, sum by (prompt_id) (ihub_prompt_usage_total))
```

#### `ihub.errors`
- **Type:** Counter
- **Unit:** `{error}`
- **Description:** Error occurrences
- **Dimensions:**
  - `error.type` - Error classification
  - `error.context` - Where error occurred

**Example Query (PromQL):**
```promql
# Error rate in last 5 minutes
rate(ihub_errors_total[5m])

# Errors by type
sum by (error_type) (ihub_errors_total)
```

#### `ihub.conversations`
- **Type:** Counter
- **Unit:** `{message}`
- **Description:** Conversation tracking
- **Dimensions:**
  - `conversation.id` - Chat session ID
  - `conversation.is_follow_up` - Whether message is a follow-up

**Example Query (PromQL):**
```promql
# Total conversations
count(ihub_conversations_total)

# Follow-up message ratio
sum(ihub_conversations_total{conversation_is_follow_up="true"}) / sum(ihub_conversations_total)
```

---

## Integration Examples

### Prometheus + Grafana

1. **Configure iHub for Prometheus:**

```json
{
  "telemetry": {
    "enabled": true,
    "provider": "prometheus",
    "exporters": {
      "prometheus": {
        "port": 9464
      }
    }
  }
}
```

2. **Add Prometheus scrape config (`prometheus.yml`):**

```yaml
scrape_configs:
  - job_name: 'ihub-apps'
    static_configs:
      - targets: ['localhost:9464']
    scrape_interval: 15s
```

3. **Access metrics:**
```bash
curl http://localhost:9464/metrics
```

4. **Create Grafana dashboard:**
   - Import dashboard JSON from `examples/grafana-dashboards/`
   - Add Prometheus as data source
   - Visualize metrics

### Jaeger (Distributed Tracing)

1. **Start Jaeger with OTLP support:**

```bash
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

2. **Configure iHub:**

```json
{
  "telemetry": {
    "enabled": true,
    "provider": "otlp",
    "exporters": {
      "otlp": {
        "endpoint": "http://localhost:4318"
      }
    }
  }
}
```

3. **View traces:**
   - Open http://localhost:16686
   - Select "ihub-apps" service
   - View LLM operation traces

### Grafana Cloud

1. **Get OTLP endpoint from Grafana Cloud:**
   - Navigate to "Connections" → "OpenTelemetry"
   - Copy OTLP endpoint and API token

2. **Configure iHub:**

```json
{
  "telemetry": {
    "enabled": true,
    "provider": "otlp",
    "exporters": {
      "otlp": {
        "endpoint": "https://otlp-gateway-prod-us-east-0.grafana.net/otlp",
        "headers": {
          "authorization": "Basic YOUR_BASE64_TOKEN"
        }
      }
    }
  }
}
```

---

## Use Cases

### Monitor App Usage

**Question:** Which apps are most used?

**Query:**
```promql
topk(10, sum by (app_id) (rate(ihub_app_usage_total[1h])))
```

**Grafana Panel:** Bar chart showing top apps

---

### Track Token Consumption

**Question:** How many tokens are we using per model?

**Query:**
```promql
sum by (gen_ai_request_model, gen_ai_token_type) (
  increase(gen_ai_client_token_usage_sum[24h])
)
```

**Grafana Panel:** Stacked area chart

---

### Identify Performance Issues

**Question:** Which models have the highest latency?

**Query:**
```promql
histogram_quantile(0.99, 
  sum by (le, gen_ai_request_model) (
    rate(gen_ai_client_operation_duration_bucket[5m])
  )
)
```

**Grafana Panel:** Time series graph

---

### Detect Errors

**Question:** What's our error rate?

**Query:**
```promql
sum(rate(ihub_errors_total[5m])) by (error_type)
```

**Alert Rule:**
```yaml
alert: HighErrorRate
expr: rate(ihub_errors_total[5m]) > 0.1
for: 5m
annotations:
  summary: "High error rate detected"
```

---

### Analyze Conversation Patterns

**Question:** How many messages are follow-ups?

**Query:**
```promql
sum(ihub_conversations_total{conversation_is_follow_up="true"}) / 
sum(ihub_conversations_total)
```

**Grafana Panel:** Gauge showing percentage

---

## Privacy & Security

### Default Privacy Settings

By default, iHub Apps **does not** track:
- User prompts
- AI completions
- System instructions
- Tool definitions

Only metadata is tracked:
- Token counts
- Model names
- Latencies
- Error types

### Enabling Sensitive Data Tracking

⚠️ **For debugging only - never in production**

```json
{
  "telemetry": {
    "events": {
      "includePrompts": true,
      "includeCompletions": true
    },
    "spans": {
      "includeOptInAttributes": true
    }
  }
}
```

### Best Practices

1. **Production:** Keep sensitive data tracking disabled
2. **Development:** Can enable for debugging
3. **Access Control:** Restrict telemetry backend access
4. **Data Retention:** Configure retention policies
5. **Compliance:** Ensure telemetry complies with data regulations

---

## Troubleshooting

### Metrics Not Appearing

1. **Check telemetry is enabled:**
```bash
curl http://localhost:3000/api/health | jq .telemetry
```

2. **Verify Prometheus endpoint:**
```bash
curl http://localhost:9464/metrics | grep ihub
```

3. **Check server logs:**
```bash
npm run logs | grep -i telemetry
```

### High Performance Impact

1. **Reduce sampling rate:**
```json
{
  "telemetry": {
    "spans": {
      "sampleRate": 0.1
    }
  }
}
```

2. **Disable events:**
```json
{
  "telemetry": {
    "events": {
      "enabled": false
    }
  }
}
```

3. **Increase export interval:**
```json
{
  "telemetry": {
    "metrics": {
      "exportInterval": 120000
    }
  }
}
```

### OTLP Connection Failures

1. **Verify endpoint is reachable:**
```bash
curl -v http://localhost:4318/v1/traces
```

2. **Check authentication:**
```bash
# Test with headers
curl -H "authorization: Bearer YOUR_TOKEN" http://your-otlp-endpoint/v1/traces
```

3. **Check firewall rules:**
   - Ensure port 4318 is open
   - Verify network connectivity

---

## Performance Impact

### Typical Overhead

| Configuration | CPU Overhead | Memory Overhead |
|--------------|--------------|-----------------|
| Spans only | <1% | ~10 MB |
| Spans + Metrics | 2-3% | ~20 MB |
| All features | 3-5% | ~30 MB |

### Optimization Tips

1. **Use sampling for high-volume deployments**
2. **Disable events in production**
3. **Use OTLP over Prometheus (lower overhead)**
4. **Batch metric exports (increase interval)**

---

## Support

For issues or questions:
1. Check server logs: `npm run logs`
2. Review configuration: `contents/config/platform.json`
3. Consult documentation: `docs/telemetry/`
4. Report issues: GitHub Issues

---

**Next:** [Grafana Dashboard Setup Guide](./grafana-dashboards.md)
