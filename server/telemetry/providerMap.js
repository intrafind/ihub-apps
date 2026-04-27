/**
 * Single source of truth for mapping iHub provider IDs to OpenTelemetry
 * gen-ai semantic-conventions values. Both NonStreamingHandler /
 * llmInstrumentation and StreamingHandler import from here so the two paths
 * agree on `gen_ai.provider.name` and `gen_ai.operation.name`.
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

const PROVIDER_NAME_MAP = {
  openai: 'openai',
  'openai-responses': 'openai',
  anthropic: 'anthropic',
  google: 'google',
  mistral: 'mistral_ai',
  local: 'openai', // vLLM uses an OpenAI-compatible API
  vllm: 'openai',
  'iassistant-conversation': 'iassistant'
};

const OPERATION_MAP = {
  google: 'generate_content',
  // default for openai/anthropic/mistral/etc.
  default: 'chat'
};

export function resolveProviderName(provider) {
  return PROVIDER_NAME_MAP[provider] || provider || 'unknown';
}

export function resolveOperation(provider) {
  return OPERATION_MAP[provider] || OPERATION_MAP.default;
}

export { PROVIDER_NAME_MAP, OPERATION_MAP };
