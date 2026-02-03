# OpenTelemetry Gen-AI Implementation Plan

**Date:** 2026-01-21  
**Related:** [OpenTelemetry Gen-AI Integration.md](./2026-01-21%20OpenTelemetry%20Gen-AI%20Integration.md)  
**Status:** In Progress

---

## Implementation Order

This document outlines the step-by-step implementation plan for adding OpenTelemetry gen-ai semantic conventions to iHub Apps.

---

## Phase 1: Core Infrastructure Setup

### Step 1.1: Install Required Packages
**File:** `server/package.json`

Add OpenTelemetry packages for gen-ai instrumentation:
```json
{
  "dependencies": {
    "@opentelemetry/exporter-trace-otlp-http": "^0.54.0",
    "@opentelemetry/sdk-metrics": "^1.29.0",
    "@opentelemetry/semantic-conventions": "^1.29.0"
  }
}
```

**Validation:**
- Run `npm install` in server directory
- Verify packages installed correctly

---

### Step 1.2: Create Telemetry Directory Structure
**Location:** `server/telemetry/`

Create new directory structure:
```
server/telemetry/
├── GenAIInstrumentation.js    # Main instrumentation class
├── attributes.js               # Attribute builders and constants
├── events.js                   # Event emission helpers
├── metrics.js                  # Metric recording helpers
└── exporters.js                # Exporter configuration helpers
```

---

### Step 1.3: Implement Attribute Builders
**File:** `server/telemetry/attributes.js`

Create helper functions for building gen-ai attributes:
- `buildProviderAttributes()` - Provider-specific attributes
- `buildRequestAttributes()` - Request attributes (temperature, max_tokens, etc.)
- `buildResponseAttributes()` - Response attributes (tokens, finish_reason, etc.)
- `buildErrorAttributes()` - Error attributes
- `buildCustomAttributes()` - iHub-specific attributes (app.id, user.id, etc.)

**Key Functions:**
```javascript
export function buildProviderAttributes(provider) {
  const providerMap = {
    'openai': 'openai',
    'anthropic': 'anthropic',
    'google': 'gcp.gemini',
    'mistral': 'mistral_ai'
  };
  return {
    'gen_ai.provider.name': providerMap[provider] || provider
  };
}

export function buildRequestAttributes(model, options) {
  return {
    'gen_ai.request.model': model.modelId,
    'gen_ai.request.temperature': options.temperature,
    'gen_ai.request.max_tokens': options.maxTokens,
    // ... more attributes
  };
}
```

---

### Step 1.4: Implement Event Emitters
**File:** `server/telemetry/events.js`

Create event emission helpers:
- `emitPromptEvent()` - Emit gen_ai.content.prompt event
- `emitCompletionEvent()` - Emit gen_ai.content.completion event
- `emitChoiceEvent()` - Emit gen_ai.choice event (for tool calls)

**Key Functions:**
```javascript
export function emitPromptEvent(span, messages, config) {
  if (!config.events?.includePrompts) return;
  
  span.addEvent('gen_ai.content.prompt', {
    'gen_ai.prompt': sanitizeContent(messages, config),
    'index': 0
  });
}
```

---

### Step 1.5: Implement Metric Recorders
**File:** `server/telemetry/metrics.js`

Create metric recording helpers:
- `recordTokenUsage()` - Record gen_ai.client.token.usage
- `recordOperationDuration()` - Record gen_ai.client.operation.duration

**Key Functions:**
```javascript
export function recordTokenUsage(meterProvider, attributes) {
  const histogram = meterProvider
    .getMeter('ihub-apps-genai')
    .createHistogram('gen_ai.client.token.usage', {
      description: 'Number of input and output tokens used',
      unit: '{token}',
      advice: {
        explicitBucketBoundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576]
      }
    });
  
  histogram.record(attributes.tokens, attributes);
}
```

---

### Step 1.6: Create GenAI Instrumentation Class
**File:** `server/telemetry/GenAIInstrumentation.js`

Main instrumentation wrapper:
```javascript
import { trace, context } from '@opentelemetry/api';
import { buildProviderAttributes, buildRequestAttributes, buildResponseAttributes } from './attributes.js';
import { emitPromptEvent, emitCompletionEvent } from './events.js';
import { recordTokenUsage, recordOperationDuration } from './metrics.js';

export class GenAIInstrumentation {
  constructor(config = {}) {
    this.config = config;
    this.tracer = trace.getTracer('ihub-apps-genai', '1.0.0');
    this.enabled = config.enabled !== false;
  }

  // Create a span for an LLM operation
  createLLMSpan(operation, model, provider, attributes = {}) {
    if (!this.enabled) return null;
    
    const spanName = `${operation} ${model.modelId}`;
    return this.tracer.startSpan(spanName, {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': operation,
        ...buildProviderAttributes(provider),
        ...attributes
      }
    });
  }

  // Record LLM request
  recordRequest(span, model, messages, options) {
    if (!span || !this.enabled) return;
    
    span.setAttributes(buildRequestAttributes(model, options));
    emitPromptEvent(span, messages, this.config);
  }

  // Record LLM response
  recordResponse(span, response, usage) {
    if (!span || !this.enabled) return;
    
    span.setAttributes(buildResponseAttributes(response));
    emitCompletionEvent(span, response, this.config);
    
    if (usage) {
      recordTokenUsage(this.meterProvider, {
        ...span.attributes,
        'gen_ai.token.type': 'input',
        tokens: usage.inputTokens
      });
      recordTokenUsage(this.meterProvider, {
        ...span.attributes,
        'gen_ai.token.type': 'output',
        tokens: usage.outputTokens
      });
    }
  }

  // End span with optional error
  endSpan(span, error = null) {
    if (!span || !this.enabled) return;
    
    if (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.setAttribute('error.type', error.name || 'unknown');
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    
    span.end();
  }
}
```

---

### Step 1.7: Enhance Main Telemetry Module
**File:** `server/telemetry.js`

Update to export GenAI instrumentation:
```javascript
import { GenAIInstrumentation } from './telemetry/GenAIInstrumentation.js';

let genAIInstrumentation = null;

export async function initTelemetry(config = {}) {
  // ... existing code ...
  
  // Initialize GenAI instrumentation
  if (config.enabled) {
    genAIInstrumentation = new GenAIInstrumentation(config);
  }
}

export function getGenAIInstrumentation() {
  return genAIInstrumentation;
}
```

---

## Phase 2: Adapter Instrumentation

### Step 2.1: Enhance BaseAdapter
**File:** `server/adapters/BaseAdapter.js`

Add instrumentation hooks to base adapter:
```javascript
import { getGenAIInstrumentation } from '../telemetry.js';

export class BaseAdapter {
  constructor() {
    this.instrumentation = null;
  }

  setInstrumentation(instrumentation) {
    this.instrumentation = instrumentation;
  }

  // Wrap API call with instrumentation
  async instrumentedApiCall(operation, model, messages, options, apiFn) {
    const span = this.instrumentation?.createLLMSpan(
      operation,
      model,
      this.getProviderName(),
      this.getCustomAttributes()
    );

    try {
      this.instrumentation?.recordRequest(span, model, messages, options);
      
      const startTime = Date.now();
      const response = await apiFn();
      const duration = (Date.now() - startTime) / 1000;
      
      this.instrumentation?.recordResponse(span, response, response.usage);
      this.instrumentation?.recordOperationDuration(duration, span.attributes);
      
      return response;
    } catch (error) {
      this.instrumentation?.endSpan(span, error);
      throw error;
    } finally {
      this.instrumentation?.endSpan(span);
    }
  }

  // Override in subclasses
  getProviderName() {
    return 'unknown';
  }

  getCustomAttributes() {
    return {};
  }
}
```

---

### Step 2.2: Instrument OpenAI Adapter
**File:** `server/adapters/openai.js`

Add OpenAI-specific instrumentation:
```javascript
class OpenAIAdapterClass extends BaseAdapter {
  getProviderName() {
    return 'openai';
  }

  async createCompletion(model, messages, apiKey, options) {
    return this.instrumentedApiCall(
      'chat',
      model,
      messages,
      options,
      async () => {
        // Existing OpenAI API call logic
        const request = this.createCompletionRequest(model, messages, apiKey, options);
        const response = await this.executeRequest(request);
        return this.parseResponse(response);
      }
    );
  }
}
```

---

### Step 2.3: Instrument Other Adapters
**Files:**
- `server/adapters/anthropic.js`
- `server/adapters/google.js`
- `server/adapters/mistral.js`

Repeat instrumentation pattern for each adapter with provider-specific attributes.

---

## Phase 3: Service Integration

### Step 3.1: Instrument ChatService
**File:** `server/services/chat/ChatService.js`

Add parent span for chat operations:
```javascript
async processChat(params) {
  const tracer = trace.getTracer('ihub-apps');
  const span = tracer.startSpan('chat.process', {
    attributes: {
      'app.id': params.appId,
      'user.id': params.user?.id,
      'conversation.id': params.chatId
    }
  });

  try {
    const result = await this._processChat(params);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
```

---

### Step 3.2: Instrument StreamingHandler
**File:** `server/services/chat/StreamingHandler.js`

Add event tracking for streaming chunks:
```javascript
async executeStreamingResponse(params) {
  const span = trace.getActiveSpan();
  let tokenCount = 0;

  for await (const chunk of streamResponse) {
    tokenCount += chunk.tokens;
    
    // Track streaming progress
    if (tokenCount % 100 === 0) {
      span?.addEvent('streaming.progress', {
        'tokens.received': tokenCount
      });
    }
  }
}
```

---

### Step 3.3: Instrument ToolExecutor
**File:** `server/services/chat/ToolExecutor.js`

Add tool call tracking:
```javascript
async executeTool(toolCall, params) {
  const tracer = trace.getTracer('ihub-apps');
  const span = tracer.startSpan('tool.execute', {
    attributes: {
      'tool.name': toolCall.name,
      'tool.id': toolCall.id
    }
  });

  try {
    const result = await this._executeTool(toolCall, params);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
```

---

## Phase 4: Configuration & Exporters

### Step 4.1: Add OTLP Exporter Support
**File:** `server/telemetry/exporters.js`

Create exporter configuration:
```javascript
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

export function createExporters(config) {
  const exporters = {};

  if (config.exporters?.otlp) {
    exporters.trace = new OTLPTraceExporter({
      url: config.exporters.otlp.endpoint + '/v1/traces',
      headers: config.exporters.otlp.headers
    });
    exporters.metrics = new OTLPMetricExporter({
      url: config.exporters.otlp.endpoint + '/v1/metrics',
      headers: config.exporters.otlp.headers
    });
  }

  if (config.exporters?.prometheus) {
    // Keep existing Prometheus exporter
  }

  return exporters;
}
```

---

### Step 4.2: Update Platform Configuration Schema
**File:** `server/defaults/config/platform.json`

Add telemetry configuration:
```json
{
  "telemetry": {
    "enabled": false,
    "provider": "console",
    
    "exporters": {
      "otlp": {
        "endpoint": "${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}",
        "protocol": "http/protobuf",
        "headers": {}
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
    
    "resource": {
      "service.name": "ihub-apps",
      "service.version": "auto",
      "deployment.environment": "${NODE_ENV:-development}"
    }
  }
}
```

---

### Step 4.3: Add Environment Variable Support
**File:** `.env.example`

Add telemetry environment variables:
```bash
# OpenTelemetry Configuration
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_HEADERS=
OTEL_SERVICE_NAME=ihub-apps
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.version=4.2.0
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=1.0
```

---

## Phase 5: Testing & Validation

### Step 5.1: Create Unit Tests
**File:** `server/tests/telemetry/genai-instrumentation.test.js`

Test instrumentation:
```javascript
describe('GenAI Instrumentation', () => {
  test('creates span with correct attributes', () => {
    // Test span creation
  });

  test('records token usage metrics', () => {
    // Test metric recording
  });

  test('emits events when configured', () => {
    // Test event emission
  });

  test('sanitizes sensitive content', () => {
    // Test content sanitization
  });
});
```

---

### Step 5.2: Integration Testing
**File:** `server/tests/telemetry/integration.test.js`

Test end-to-end flow:
```javascript
describe('Telemetry Integration', () => {
  test('full chat request generates telemetry', async () => {
    // Mock LLM API
    // Send chat request
    // Verify span created
    // Verify metrics recorded
    // Verify events emitted
  });

  test('streaming response tracked correctly', async () => {
    // Test streaming telemetry
  });

  test('tool calls generate separate spans', async () => {
    // Test tool instrumentation
  });
});
```

---

### Step 5.3: Observability Stack Testing
**Setup:**
1. Docker Compose with Prometheus, Grafana, Jaeger
2. Test metric scraping
3. Test trace visualization
4. Verify dashboard queries

**File:** `docker/docker-compose.observability.yml`
```yaml
version: '3.8'
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"
      - "14268:14268"
      - "4318:4318"
```

---

## Phase 6: Documentation

### Step 6.1: User Documentation
**File:** `docs/observability-setup.md`

Create comprehensive setup guide:
- Quick start with Docker Compose
- Prometheus configuration
- Grafana dashboard setup
- Jaeger trace visualization
- Common queries and dashboards

---

### Step 6.2: Developer Documentation
**File:** `docs/telemetry-api.md`

Document instrumentation API:
- How to add custom attributes
- How to create custom spans
- How to emit custom events
- Best practices

---

### Step 6.3: Example Dashboards
**Location:** `examples/grafana-dashboards/`

Provide pre-built dashboards:
- `app-usage-dashboard.json` - App usage metrics
- `llm-performance-dashboard.json` - LLM performance
- `error-tracking-dashboard.json` - Error monitoring
- `cost-estimation-dashboard.json` - Token usage and costs

---

## Phase 7: Migration & Rollout

### Step 7.1: Backward Compatibility
- Ensure telemetry is opt-in (disabled by default initially)
- Existing `recordTokenUsage()` continues to work
- No breaking changes to existing APIs

---

### Step 7.2: Gradual Rollout
1. **Week 1:** Deploy with telemetry disabled, test in staging
2. **Week 2:** Enable console exporter in production, monitor performance
3. **Week 3:** Enable Prometheus exporter, set up dashboards
4. **Week 4:** Enable OTLP exporter, integrate with Jaeger

---

### Step 7.3: Performance Monitoring
- Monitor CPU/memory impact of telemetry
- Adjust sampling rate if needed
- Optimize attribute collection

---

## Validation Checklist

### Code Quality
- [ ] All files pass ESLint
- [ ] All files formatted with Prettier
- [ ] No console warnings in production
- [ ] Code follows existing patterns

### Functionality
- [ ] Spans created with correct attributes
- [ ] Events emitted as configured
- [ ] Metrics recorded accurately
- [ ] Context propagated correctly
- [ ] Errors tracked properly

### Security
- [ ] No PII in telemetry by default
- [ ] Content sanitization working
- [ ] Access controls documented
- [ ] Security review completed

### Performance
- [ ] <5% overhead with telemetry enabled
- [ ] Sampling working correctly
- [ ] No memory leaks
- [ ] Load testing passed

### Integration
- [ ] Prometheus scraping metrics
- [ ] Grafana displaying dashboards
- [ ] Jaeger showing traces
- [ ] OTLP exporter working
- [ ] All adapters instrumented

### Documentation
- [ ] Setup guide complete
- [ ] API documentation complete
- [ ] Example configurations provided
- [ ] Troubleshooting guide created

---

## Success Criteria

### Must Have
- ✅ All LLM adapters instrumented
- ✅ Spans follow gen-ai semantic conventions
- ✅ Metrics exportable to Prometheus
- ✅ Configuration via platform.json
- ✅ Documentation complete

### Should Have
- ✅ OTLP exporter support
- ✅ Jaeger integration
- ✅ Grafana dashboards
- ✅ Content sanitization
- ✅ Performance <5% overhead

### Nice to Have
- ⭕ Custom dashboard builder
- ⭕ Alerting examples
- ⭕ Cost calculation helper
- ⭕ Anomaly detection

---

## Timeline

| Phase | Duration | Deliverables |
|-------|----------|-------------|
| Phase 1 | 2 days | Core infrastructure |
| Phase 2 | 2 days | Adapter instrumentation |
| Phase 3 | 1 day | Service integration |
| Phase 4 | 1 day | Configuration |
| Phase 5 | 2 days | Testing |
| Phase 6 | 1 day | Documentation |
| Phase 7 | 1 day | Rollout |
| **Total** | **10 days** | Full implementation |

---

## Next Steps

1. ✅ Create documentation (this file)
2. ⏳ Install dependencies
3. ⏳ Create telemetry directory structure
4. ⏳ Implement attribute builders
5. ⏳ Implement event emitters
6. ⏳ Implement metric recorders
7. ⏳ Create GenAIInstrumentation class
8. ... (continue with implementation)

---

**Document Version:** 1.0  
**Last Updated:** 2026-01-21  
**Status:** Ready to Execute
