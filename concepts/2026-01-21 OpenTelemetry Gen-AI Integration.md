# OpenTelemetry Gen-AI Integration for iHub Apps

**Date:** 2026-01-21  
**Status:** Implementation Planning  
**Objective:** Implement comprehensive observability for iHub Apps using OpenTelemetry semantic conventions for Generative AI

---

## Executive Summary

This document outlines the implementation of OpenTelemetry (OTel) for iHub Apps following the official semantic conventions for Generative AI operations. This will enable administrators to monitor app usage, track errors, measure performance, and gain insights into LLM interactions through industry-standard observability tools like Prometheus, Grafana, Jaeger, and others.

---

## Background

### Current State

iHub Apps currently has basic telemetry infrastructure:
- **File:** `server/telemetry.js` with OpenTelemetry SDK initialization
- **Metrics:** Basic token usage counter via `recordTokenUsage()`
- **Exporters:** Prometheus exporter for metrics, Console exporter for traces
- **Logging:** Console log interception with OpenTelemetry logs
- **Usage Tracking:** `usageTracker.js` captures messages, tokens, and feedback

### What's Missing

- **Semantic Conventions:** Not following gen-ai semantic conventions
- **Structured Spans:** No instrumentation around LLM API calls
- **Events:** No gen_ai.content.prompt/completion events
- **Proper Metrics:** Token usage doesn't follow gen_ai.client.token.usage format
- **Context Propagation:** No trace context across async operations
- **Provider-Specific Attributes:** Missing provider-specific metadata
- **Tool Call Tracking:** No visibility into tool/function call usage

---

## OpenTelemetry Gen-AI Semantic Conventions

### Overview

OpenTelemetry defines specific semantic conventions for Generative AI operations to ensure consistency across different implementations and tools. The conventions cover:

1. **Spans** - Trace individual LLM operations
2. **Events** - Capture prompt/completion content
3. **Metrics** - Measure token usage and operation duration
4. **Attributes** - Standardized metadata for gen-ai operations

Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/

---

## 1. Spans (gen_ai Spans)

### Purpose
Spans represent individual LLM API calls or operations, tracking their lifecycle from request to response.

### Span Configuration

**Span Name Format:** `{gen_ai.operation.name} {gen_ai.request.model}`
- Example: `chat gpt-4`, `generate_content gemini-2.0-flash`

**Span Kind:** `CLIENT` (for remote API calls) or `INTERNAL` (for local models)

**Span Status:** Follow [Recording Errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/) guidelines

### Required Attributes

| Attribute | Type | Description | Example |
|-----------|------|-------------|---------|
| `gen_ai.operation.name` | string | Type of operation | `chat`, `generate_content`, `text_completion` |
| `gen_ai.provider.name` | string | AI provider identifier | `openai`, `anthropic`, `gcp.gemini`, `mistral_ai` |

### Conditionally Required Attributes

| Attribute | Type | Condition | Description | Example |
|-----------|------|-----------|-------------|---------|
| `error.type` | string | On error | Error classification | `timeout`, `rate_limit_exceeded`, `500` |
| `gen_ai.conversation.id` | string | When available | Conversation/session ID | `conv_5j66UpCpwteGg4YSxUnt7lPY` |
| `gen_ai.output.type` | string | When known | Output content type | `text`, `json`, `image` |
| `gen_ai.request.choice.count` | int | When != 1 | Number of completions requested | `3` |
| `gen_ai.request.model` | string | If available | Model name requested | `gpt-4`, `claude-4-opus` |
| `gen_ai.request.seed` | int | If seed used | Seed for reproducibility | `100` |
| `server.port` | int | If server.address set | Server port | `443` |

### Recommended Attributes

| Attribute | Type | Description | Example |
|-----------|------|-------------|---------|
| `gen_ai.request.frequency_penalty` | double | Frequency penalty | `0.1` |
| `gen_ai.request.max_tokens` | int | Max tokens to generate | `1024` |
| `gen_ai.request.presence_penalty` | double | Presence penalty | `0.1` |
| `gen_ai.request.stop_sequences` | string[] | Stop sequences | `["END", "STOP"]` |
| `gen_ai.request.temperature` | double | Temperature setting | `0.7` |
| `gen_ai.request.top_k` | double | Top-K sampling | `40` |
| `gen_ai.request.top_p` | double | Top-P sampling | `0.9` |
| `gen_ai.response.finish_reasons` | string[] | Why generation stopped | `["stop"]`, `["length"]` |
| `gen_ai.response.id` | string | Response/completion ID | `chatcmpl-123` |
| `gen_ai.response.model` | string | Actual model used | `gpt-4-0613` |
| `gen_ai.usage.input_tokens` | int | Prompt tokens | `100` |
| `gen_ai.usage.output_tokens` | int | Completion tokens | `180` |
| `server.address` | string | API endpoint | `api.openai.com` |

### Opt-In Attributes (High Cardinality)

| Attribute | Type | Description | Notes |
|-----------|------|-------------|-------|
| `gen_ai.input.messages` | any | Full chat history | May contain PII/sensitive data |
| `gen_ai.output.messages` | any | Model responses | May contain PII/sensitive data |
| `gen_ai.system_instructions` | any | System prompts | May contain business logic |
| `gen_ai.tool.definitions` | any | Tool/function definitions | Large payloads |

**⚠️ Security Note:** Opt-in attributes may contain sensitive data. Implement proper sanitization and access controls.

---

## 2. Events (gen_ai Events)

### Purpose
Events capture detailed information about prompts and completions during LLM operations.

### Event Types

#### 2.1 `gen_ai.content.prompt`
Emitted when sending input to the model.

**Attributes:**
- `gen_ai.prompt` - The prompt text/content
- `index` - Index in multi-turn conversations

#### 2.2 `gen_ai.content.completion`
Emitted when receiving output from the model.

**Attributes:**
- `gen_ai.completion` - The completion text/content
- `index` - Index when multiple choices returned
- `finish_reason` - Why generation stopped

#### 2.3 `gen_ai.choice`
Emitted for tool calls and structured outputs.

**Attributes:**
- `choice` - Full choice object with tool calls
- `index` - Choice index

---

## 3. Metrics (gen_ai Metrics)

### 3.1 `gen_ai.client.token.usage`

**Type:** Histogram  
**Unit:** `{token}`  
**Description:** Number of input and output tokens used  
**Buckets:** `[1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864]`

**Required Attributes:**
- `gen_ai.operation.name` - Operation type
- `gen_ai.provider.name` - AI provider
- `gen_ai.token.type` - `input` or `output`

**Conditionally Required:**
- `gen_ai.request.model` - If available

**Recommended:**
- `gen_ai.response.model` - Actual model used
- `server.address` - API endpoint
- `server.port` - API port

### 3.2 `gen_ai.client.operation.duration`

**Type:** Histogram  
**Unit:** `s` (seconds)  
**Description:** Duration of GenAI operation  
**Buckets:** `[0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]`

**Required Attributes:**
- `gen_ai.operation.name` - Operation type
- `gen_ai.provider.name` - AI provider

**Conditionally Required:**
- `gen_ai.request.model` - If available
- `error.type` - On error

**Recommended:**
- `gen_ai.response.model` - Actual model used
- `server.address` - API endpoint
- `server.port` - API port

---

## 4. Provider-Specific Conventions

### 4.1 OpenAI

**Provider Name:** `openai`

**Operation Names:**
- `chat` - For chat completions
- `text_completion` - For legacy completions

**Specific Attributes:**
- `openai.response.service_tier` - Service tier used
- Standard gen_ai attributes apply

### 4.2 Anthropic

**Provider Name:** `anthropic`

**Operation Names:**
- `chat` - For messages API

**Specific Attributes:**
- Standard gen_ai attributes apply

### 4.3 Google (Gemini)

**Provider Name:** `gcp.gemini` (AI Studio) or `gcp.vertex_ai` (Vertex AI)

**Operation Names:**
- `generate_content` - For content generation

**Specific Attributes:**
- Standard gen_ai attributes apply
- Support for thinking/reasoning budget

### 4.4 Mistral

**Provider Name:** `mistral_ai`

**Operation Names:**
- `chat` - For chat completions

**Specific Attributes:**
- Standard gen_ai attributes apply

---

## 5. Implementation Architecture

### 5.1 Code Structure

```
server/
├── telemetry.js                    # Enhanced telemetry initialization
├── telemetry/
│   ├── GenAIInstrumentation.js    # Gen-AI instrumentation wrapper
│   ├── attributes.js               # Attribute builders
│   ├── events.js                   # Event emitters
│   └── metrics.js                  # Metric recorders
├── adapters/
│   ├── BaseAdapter.js              # Enhanced with instrumentation
│   ├── openai.js                   # OpenAI-specific instrumentation
│   ├── anthropic.js                # Anthropic-specific instrumentation
│   ├── google.js                   # Google-specific instrumentation
│   └── mistral.js                  # Mistral-specific instrumentation
└── services/chat/
    ├── ChatService.js              # Request-level spans
    ├── StreamingHandler.js         # Streaming event tracking
    └── ToolExecutor.js             # Tool call tracking
```

### 5.2 Instrumentation Flow

```
1. ChatService.processChat()
   └─ Create parent span: "chat operation"
      ├─ Set app.id, user.id, conversation.id
      │
      └─ BaseAdapter.createCompletionRequest()
         └─ Create child span: "chat gpt-4"
            ├─ Set gen_ai.* attributes
            ├─ Emit event: gen_ai.content.prompt
            │
            └─ HTTP call to LLM API
               ├─ Record gen_ai.client.operation.duration
               ├─ Record gen_ai.client.token.usage
               ├─ Emit event: gen_ai.content.completion
               └─ Set response attributes
```

### 5.3 Context Propagation

- Use OpenTelemetry Context API for async operations
- Propagate trace context across streaming responses
- Link spans across tool call iterations
- Preserve user/session context throughout request lifecycle

---

## 6. Configuration Schema

### platform.json Enhancement

```json
{
  "telemetry": {
    "enabled": true,
    "provider": "otlp",  // or "prometheus", "jaeger", "console"
    
    "exporters": {
      "otlp": {
        "endpoint": "http://localhost:4318",
        "protocol": "http/protobuf",
        "headers": {}
      },
      "prometheus": {
        "port": 9464,
        "host": "0.0.0.0"
      },
      "jaeger": {
        "endpoint": "http://localhost:14268/api/traces"
      }
    },
    
    "spans": {
      "enabled": true,
      "sampleRate": 1.0,
      "includeOptInAttributes": false,  // Privacy: don't include full messages by default
      "sanitizeContent": true            // Sanitize PII from content
    },
    
    "events": {
      "enabled": true,
      "includePrompts": false,           // Privacy: opt-in for prompts
      "includeCompletions": false,       // Privacy: opt-in for completions
      "maxEventSize": 1024               // Truncate large events
    },
    
    "metrics": {
      "enabled": true,
      "exportInterval": 60000            // Export every 60 seconds
    },
    
    "logs": {
      "enabled": true,
      "level": "info"
    },
    
    "resource": {
      "service.name": "ihub-apps",
      "service.version": "auto",         // Auto-detect from package.json
      "deployment.environment": "production"
    }
  }
}
```

### Environment Variables

```bash
# OpenTelemetry Configuration
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20token
OTEL_SERVICE_NAME=ihub-apps
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.version=4.2.0
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1  # Sample 10% of traces
```

---

## 7. Use Cases for Administrators

### 7.1 App Usage Tracking

**Metrics to Track:**
- Request count per app (custom attribute: `app.id`)
- Request count per user (custom attribute: `user.id`)
- Request count per model
- Token usage per app/user/model

**Queries (PromQL):**
```promql
# Total requests per app
sum by (app_id) (gen_ai_client_operation_duration_count)

# Token usage per model
sum by (gen_ai_request_model, gen_ai_token_type) (gen_ai_client_token_usage_sum)

# Average operation duration per provider
avg by (gen_ai_provider_name) (gen_ai_client_operation_duration_sum / gen_ai_client_operation_duration_count)
```

### 7.2 Error Tracking

**Metrics to Track:**
- Error count by type
- Error rate per provider
- Error rate per model

**Queries (PromQL):**
```promql
# Error rate by provider
sum by (gen_ai_provider_name, error_type) (gen_ai_client_operation_duration_count{error_type!=""})

# Errors in last hour
increase(gen_ai_client_operation_duration_count{error_type!=""}[1h])
```

### 7.3 Performance Monitoring

**Metrics to Track:**
- P50, P95, P99 latencies per operation
- Tokens per second throughput
- Request rate limits

**Queries (PromQL):**
```promql
# P95 latency per model
histogram_quantile(0.95, sum by (le, gen_ai_request_model) (gen_ai_client_operation_duration_bucket))

# Token throughput (tokens/sec)
rate(gen_ai_client_token_usage_sum[5m])
```

### 7.4 Cost Estimation

**Metrics to Track:**
- Total tokens per model (for cost calculation)
- Request distribution across models
- Peak usage times

**Queries (PromQL):**
```promql
# Total input tokens (for cost calc)
sum by (gen_ai_request_model) (gen_ai_client_token_usage_sum{gen_ai_token_type="input"})

# Total output tokens (for cost calc)
sum by (gen_ai_request_model) (gen_ai_client_token_usage_sum{gen_ai_token_type="output"})
```

---

## 8. Security and Privacy Considerations

### 8.1 Sensitive Data

**Risks:**
- User prompts may contain PII, confidential data
- System prompts may reveal business logic
- Tool definitions may expose internal systems

**Mitigations:**
1. **Default to Opt-Out:** Disable `includeOptInAttributes` by default
2. **Content Sanitization:** Implement PII detection and redaction
3. **Size Limits:** Truncate large content in events
4. **Access Controls:** Restrict telemetry data access

### 8.2 Configuration Recommendations

**Production:**
```json
{
  "spans": {
    "includeOptInAttributes": false
  },
  "events": {
    "includePrompts": false,
    "includeCompletions": false
  }
}
```

**Development/Debug:**
```json
{
  "spans": {
    "includeOptInAttributes": true
  },
  "events": {
    "includePrompts": true,
    "includeCompletions": true
  }
}
```

---

## 9. Testing Strategy

### 9.1 Unit Tests
- Test span creation with correct attributes
- Test event emission
- Test metric recording
- Test attribute sanitization

### 9.2 Integration Tests
- Test full request flow with telemetry
- Test context propagation
- Test exporter configurations
- Test with real LLM providers

### 9.3 Observability Stack Testing
- Prometheus + Grafana setup
- Jaeger tracing setup
- Verify dashboard queries
- Performance impact testing

---

## 10. Documentation Updates

### 10.1 User Documentation
- Observability setup guide
- Prometheus/Grafana dashboard examples
- Metric reference
- Troubleshooting guide

### 10.2 Developer Documentation
- Instrumentation API reference
- Custom attribute guidelines
- Exporter configuration
- Best practices

---

## 11. Implementation Phases

### Phase 1: Core Infrastructure (Week 1)
- Install required packages
- Enhance telemetry.js
- Create GenAIInstrumentation class
- Add OTLP exporter support

### Phase 2: Span Instrumentation (Week 1-2)
- Instrument BaseAdapter
- Add provider-specific attributes
- Implement context propagation

### Phase 3: Events & Metrics (Week 2)
- Implement event emission
- Implement metric recording
- Add custom attributes (app.id, user.id)

### Phase 4: Integration (Week 2-3)
- Integrate with ChatService
- Integrate with StreamingHandler
- Integrate with ToolExecutor
- End-to-end testing

### Phase 5: Configuration & Documentation (Week 3)
- Platform.json schema updates
- Environment variable support
- User documentation
- Example configurations

### Phase 6: Validation (Week 3-4)
- Stack testing (Prometheus, Grafana, Jaeger)
- Performance testing
- Security review
- Production deployment

---

## 12. Success Metrics

### Implementation Success
- ✅ All adapters instrumented with gen-ai spans
- ✅ Metrics following semantic conventions
- ✅ Events properly emitted
- ✅ Context propagation working
- ✅ Tests passing with >80% coverage

### Operational Success
- ✅ Prometheus scraping metrics successfully
- ✅ Grafana dashboards displaying data
- ✅ Jaeger showing complete traces
- ✅ <5% performance overhead
- ✅ No PII leakage in telemetry data

### Business Success
- ✅ Admins can track app usage
- ✅ Admins can identify errors/issues
- ✅ Admins can estimate costs
- ✅ Admins can monitor performance
- ✅ Support team can debug issues faster

---

## 13. References

### OpenTelemetry Documentation
- [Gen-AI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Gen-AI Spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)
- [Gen-AI Events](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/)
- [Gen-AI Metrics](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/)
- [OpenAI Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/openai/)

### Implementation Examples
- [Non-normative Examples](https://opentelemetry.io/docs/specs/semconv/gen-ai/non-normative/examples-llm-calls/)

### Related iHub Docs
- `server/telemetry.js` - Current implementation
- `server/usageTracker.js` - Usage tracking
- `CLAUDE.md` - Architecture overview

---

## Appendix A: Well-Known Values

### gen_ai.operation.name
- `chat` - Chat completion (OpenAI, Anthropic, Mistral)
- `generate_content` - Multimodal generation (Gemini)
- `text_completion` - Legacy text completion
- `embeddings` - Embedding generation
- `execute_tool` - Tool/function execution
- `create_agent` - Agent creation
- `invoke_agent` - Agent invocation

### gen_ai.provider.name
- `openai` - OpenAI
- `anthropic` - Anthropic (Claude)
- `gcp.gemini` - Google Gemini (AI Studio)
- `gcp.vertex_ai` - Google Vertex AI
- `mistral_ai` - Mistral AI
- `aws.bedrock` - AWS Bedrock
- `azure.ai.openai` - Azure OpenAI

### gen_ai.token.type
- `input` - Input/prompt tokens
- `output` - Output/completion tokens

---

## Appendix B: Custom iHub Attributes

Beyond standard gen-ai conventions, iHub Apps will add:

| Attribute | Type | Description | Example |
|-----------|------|-------------|---------|
| `app.id` | string | iHub app identifier | `chat`, `summarizer` |
| `app.name` | string | iHub app name | `Chat Assistant` |
| `user.id` | string | User identifier | `user123` |
| `user.groups` | string[] | User groups | `["users", "admin"]` |
| `conversation.id` | string | Chat session ID | `sess_abc123` |
| `thinking.enabled` | boolean | Thinking mode enabled | `true` |
| `thinking.budget` | int | Thinking token budget | `5000` |
| `tool.count` | int | Number of tools available | `5` |
| `source.count` | int | Number of sources used | `3` |

---

**Document Version:** 1.0  
**Last Updated:** 2026-01-21  
**Status:** Ready for Implementation
