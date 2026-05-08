/**
 * AWS Bedrock Converse API adapter
 *
 * Authenticates with a Bedrock long-lived API key over `Authorization: Bearer …`.
 * No AWS SDK dependency: requests are sent with `fetch`, and the binary
 * `application/vnd.amazon.eventstream` response is parsed by
 * BedrockEventStreamDecoder.
 *
 * Provider name: "bedrock"
 */

import { BaseAdapter } from './BaseAdapter.js';
import { convertToolsFromGeneric } from './toolCalling/index.js';
import { convertBedrockToolChoice } from './toolCalling/BedrockConverter.js';
import { BedrockEventStreamDecoder } from './bedrockEventStream.js';
import { getReadableStream } from '../utils/streamUtils.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

/**
 * Provider-specific configuration schema. Consumed by the admin Model Form
 * Editor via `GET /api/admin/providers/bedrock/schema` to render dynamic
 * configuration fields. Values are written to `model.config[key]`.
 */
export const providerConfigSchema = {
  fields: [
    {
      key: 'region',
      label: { en: 'AWS Region', de: 'AWS-Region' },
      type: 'string',
      default: 'eu-central-1',
      enumHint: [
        'eu-central-1',
        'eu-west-1',
        'eu-west-3',
        'us-east-1',
        'us-west-2',
        'apac-northeast-1',
        'global'
      ],
      description: {
        en: 'AWS region for the Bedrock Runtime endpoint, or "global" for cross-region inference profiles (Claude Sonnet 4 family only).',
        de: 'AWS-Region für den Bedrock-Runtime-Endpunkt oder "global" für regionsübergreifende Inferenzprofile (nur Claude Sonnet 4).'
      },
      required: false
    },
    {
      key: 'additionalModelRequestFields',
      label: { en: 'Additional Model Request Fields', de: 'Zusätzliche Modell-Felder' },
      type: 'json',
      default: null,
      description: {
        en: 'Optional provider-specific fields passed in `additionalModelRequestFields` (e.g. `{ "top_k": 200 }` for Anthropic).',
        de: 'Optionale providerspezifische Felder im `additionalModelRequestFields`-Objekt.'
      },
      required: false
    }
  ]
};

const IMAGE_FORMAT_BY_MIME = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

const VALID_IMAGE_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp']);

const DOCUMENT_NAME_RE = /^[A-Za-z0-9\-()[\] ]{1,200}$/;

/**
 * Models that Bedrock requires to be invoked through a cross-region
 * inference profile (rather than a bare foundation-model ID). When the
 * configured region implies a profile cluster (us-/eu-/apac-) and the
 * model ID is bare, the adapter prepends the matching prefix.
 */
const REQUIRES_INFERENCE_PROFILE = [
  'anthropic.claude-3-5-sonnet-',
  'anthropic.claude-3-7-sonnet-',
  'anthropic.claude-sonnet-4',
  'anthropic.claude-opus-4',
  'anthropic.claude-haiku-4',
  'meta.llama4-',
  'meta.llama3-3-',
  'meta.llama3-2-',
  'amazon.nova-'
];

function regionToProfilePrefix(region) {
  if (!region) return null;
  if (region === 'global') return 'global.';
  if (region.startsWith('us-')) return 'us.';
  if (region.startsWith('eu-')) return 'eu.';
  if (region.startsWith('apac-') || region.startsWith('ap-')) return 'apac.';
  return null;
}

function modelIdHasProfilePrefix(modelId) {
  return /^(us|eu|apac|global)\./.test(modelId);
}

function modelRequiresInferenceProfile(modelId) {
  return REQUIRES_INFERENCE_PROFILE.some(prefix => modelId.startsWith(prefix));
}

function resolveEndpointRegion(region) {
  // The `global` cross-region profile is invoked through a supported source
  // region. Default to eu-central-1 to match the iHub default region.
  if (!region || region === 'global') return 'eu-central-1';
  return region;
}

function sanitizeDocumentName(name) {
  if (!name || typeof name !== 'string') return 'document';
  let sanitized = name
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^A-Za-z0-9\-()[\] ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  if (!sanitized) sanitized = 'document';
  if (!DOCUMENT_NAME_RE.test(sanitized)) sanitized = 'document';
  return sanitized;
}

class BedrockAdapterClass extends BaseAdapter {
  /**
   * Resolve the effective region from model → provider → env → default.
   */
  resolveRegion(model) {
    if (model?.config?.region) return model.config.region;
    try {
      const { data: providers = [] } = configCache.getProviders(true) || {};
      const providerConfig = providers.find(p => p.id === 'bedrock');
      if (providerConfig?.config?.region) return providerConfig.config.region;
    } catch {
      /* configCache may be unavailable in tests */
    }
    return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-central-1';
  }

  /**
   * Resolve the effective Bedrock model ID, automatically prepending the
   * cross-region inference-profile prefix where required.
   */
  resolveBedrockModelId(model, region) {
    const raw = model.modelId || model.id;
    if (modelIdHasProfilePrefix(raw)) return raw;
    const prefix = regionToProfilePrefix(region);
    if (!prefix) return raw;
    if (region === 'global' || modelRequiresInferenceProfile(raw)) {
      return `${prefix}${raw}`;
    }
    return raw;
  }

  /**
   * Format messages for Bedrock Converse. Splits system messages out into a
   * top-level `system` array and converts each remaining message into a
   * `{ role, content: [...] }` shape with text / image / toolUse / toolResult
   * content blocks.
   */
  formatMessages(messages) {
    const systemTexts = [];
    const out = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string' && msg.content.trim()) {
          systemTexts.push({ text: msg.content });
        }
        continue;
      }

      if (msg.role === 'tool') {
        const content = [];
        const parsed = this.safeJsonParse(msg.content, msg.content);
        const block = typeof parsed === 'string' ? { text: parsed } : { json: parsed };
        content.push({
          toolResult: {
            toolUseId: msg.tool_call_id,
            content: [block],
            status: msg.is_error ? 'error' : 'success'
          }
        });
        out.push({ role: 'user', content });
        continue;
      }

      const content = [];

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const call of msg.tool_calls) {
          let input = {};
          try {
            input =
              typeof call.function?.arguments === 'string'
                ? JSON.parse(call.function.arguments || '{}')
                : call.function?.arguments || {};
          } catch {
            input = {};
          }
          content.push({
            toolUse: {
              toolUseId: call.id,
              name: call.function?.name,
              input
            }
          });
        }
      }

      if (typeof msg.content === 'string' && msg.content.length > 0) {
        content.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'string' && part.length > 0) {
            content.push({ text: part });
          } else if (part?.type === 'text' && part.text) {
            content.push({ text: part.text });
          }
        }
      }

      if (this.hasImageData(msg)) {
        const images = Array.isArray(msg.imageData) ? msg.imageData : [msg.imageData];
        for (const img of images) {
          if (!img?.base64) continue;
          const format =
            IMAGE_FORMAT_BY_MIME[(img.fileType || '').toLowerCase()] ||
            IMAGE_FORMAT_BY_MIME[`image/${(img.fileType || '').toLowerCase()}`] ||
            'jpeg';
          if (!VALID_IMAGE_FORMATS.has(format)) {
            logger.warn('Skipping unsupported image format for Bedrock', {
              component: 'BedrockAdapter',
              fileType: img.fileType
            });
            continue;
          }
          content.push({
            image: {
              format,
              source: { bytes: this.cleanBase64Data(img.base64) }
            }
          });
        }
      }

      if (Array.isArray(msg.documentData)) {
        for (const doc of msg.documentData) {
          if (!doc?.base64 || !doc?.format) continue;
          content.push({
            document: {
              name: sanitizeDocumentName(doc.name || doc.fileName),
              format: doc.format,
              source: { bytes: this.cleanBase64Data(doc.base64) }
            }
          });
        }
      }

      if (content.length === 0) continue;

      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      out.push({ role, content });
    }

    // Bedrock requires the first message to be from the user.
    if (out.length > 0 && out[0].role !== 'user') {
      out.unshift({ role: 'user', content: [{ text: '' }] });
    }

    // Collapse consecutive same-role messages defensively.
    const merged = [];
    for (const m of out) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) {
        last.content = [...last.content, ...m.content];
      } else {
        merged.push(m);
      }
    }

    // Bedrock rejects empty text blocks; strip them but keep at least one
    // content block per message.
    for (const m of merged) {
      const filtered = m.content.filter(b => {
        if (b.text !== undefined) return b.text.length > 0;
        return true;
      });
      m.content = filtered.length > 0 ? filtered : [{ text: ' ' }];
    }

    // Pre-flight document count validation (Bedrock max: 5).
    const docCount = merged.reduce((n, m) => n + m.content.filter(b => b.document).length, 0);
    if (docCount > 5) {
      throw new Error(`Bedrock allows a maximum of 5 documents per request, received ${docCount}.`);
    }

    return {
      messages: merged,
      system: systemTexts.length > 0 ? systemTexts : undefined
    };
  }

  /**
   * Build the Converse request.
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const opts = this.extractRequestOptions(options);
    const { messages: bedrockMessages, system } = this.formatMessages(messages);

    const region = this.resolveRegion(model);
    const endpointRegion = resolveEndpointRegion(region);
    const modelId = this.resolveBedrockModelId(model, region);
    const stream = opts.stream;
    const op = stream ? 'converse-stream' : 'converse';
    const url = `https://bedrock-runtime.${endpointRegion}.amazonaws.com/model/${encodeURIComponent(modelId)}/${op}`;

    const inferenceConfig = {
      maxTokens: opts.maxTokens,
      temperature: opts.temperature
    };
    if (typeof options.topP === 'number') inferenceConfig.topP = options.topP;
    if (Array.isArray(options.stopSequences) && options.stopSequences.length > 0) {
      inferenceConfig.stopSequences = options.stopSequences;
    }

    const body = {
      messages: bedrockMessages,
      inferenceConfig
    };
    if (system) body.system = system;

    if (Array.isArray(opts.tools) && opts.tools.length > 0) {
      const tools = convertToolsFromGeneric(opts.tools, 'bedrock');
      if (Array.isArray(tools) && tools.length > 0) {
        body.toolConfig = {
          tools,
          toolChoice: convertBedrockToolChoice(opts.toolChoice)
        };
      }
    }

    if (model.config?.additionalModelRequestFields) {
      body.additionalModelRequestFields = model.config.additionalModelRequestFields;
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };
    if (stream) {
      headers.Accept = 'application/vnd.amazon.eventstream';
    }

    return { url, method: 'POST', headers, body };
  }

  /**
   * Stream parser. Reads raw bytes from the response, decodes the binary
   * EventStream framing, and yields normalized result chunks.
   */
  async *parseResponseStream(response) {
    const readable = getReadableStream(response);
    const reader = readable.getReader();
    const decoder = new BedrockEventStreamDecoder();
    const toolUseBlocks = new Map(); // contentBlockIndex -> { id, name, inputBuf }
    let lastFinishReason = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        const frames = decoder.feed(chunk);

        for (const frame of frames) {
          const evt = frame.eventType;
          const payload = frame.payload || {};

          if (frame.messageType === 'exception' || frame.messageType === 'error') {
            const message = payload.message || payload.Message || `Bedrock ${evt || 'error'}`;
            yield {
              content: [],
              error: true,
              errorMessage: message,
              finishReason: 'error'
            };
            return;
          }

          switch (evt) {
            case 'messageStart':
              break;

            case 'contentBlockStart': {
              const idx = payload.contentBlockIndex;
              if (payload.start?.toolUse) {
                toolUseBlocks.set(idx, {
                  id: payload.start.toolUse.toolUseId,
                  name: payload.start.toolUse.name,
                  inputBuf: ''
                });
              }
              break;
            }

            case 'contentBlockDelta': {
              const idx = payload.contentBlockIndex;
              const delta = payload.delta || {};
              if (typeof delta.text === 'string' && delta.text.length > 0) {
                yield { content: [delta.text] };
              }
              if (delta.toolUse?.input !== undefined) {
                const block = toolUseBlocks.get(idx);
                if (block) {
                  block.inputBuf += String(delta.toolUse.input ?? '');
                }
              }
              if (delta.reasoningContent?.text) {
                yield { thinking: [{ content: delta.reasoningContent.text }] };
              }
              break;
            }

            case 'contentBlockStop': {
              const idx = payload.contentBlockIndex;
              const block = toolUseBlocks.get(idx);
              if (block) {
                let parsedArgs = {};
                try {
                  parsedArgs = block.inputBuf ? JSON.parse(block.inputBuf) : {};
                } catch (err) {
                  logger.warn('Failed to parse Bedrock toolUse input as JSON', {
                    component: 'BedrockAdapter',
                    error: err.message,
                    inputBuf: block.inputBuf
                  });
                }
                yield {
                  tool_calls: [
                    {
                      index: idx,
                      id: block.id,
                      type: 'function',
                      function: {
                        name: block.name,
                        arguments: JSON.stringify(parsedArgs)
                      }
                    }
                  ]
                };
                toolUseBlocks.delete(idx);
              }
              break;
            }

            case 'messageStop': {
              const stopReason = payload.stopReason;
              lastFinishReason = mapStopReason(stopReason);
              break;
            }

            case 'metadata': {
              const usage = payload.usage || {};
              yield {
                usage: {
                  promptTokens: usage.inputTokens,
                  completionTokens: usage.outputTokens,
                  totalTokens:
                    usage.totalTokens ??
                    (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
                      ? usage.inputTokens + usage.outputTokens
                      : undefined)
                },
                complete: true,
                finishReason: lastFinishReason || 'stop'
              };
              return;
            }

            default:
              logger.debug('Unhandled Bedrock event', {
                component: 'BedrockAdapter',
                eventType: evt
              });
          }
        }
      }

      // Stream ended without metadata; signal completion.
      yield { complete: true, finishReason: lastFinishReason || 'stop' };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  getModelInfo() {
    return {
      provider: 'bedrock',
      supportsStreaming: true,
      supportsImages: true,
      supportsTools: true,
      maxTokens: null,
      contextWindow: null
    };
  }
}

function mapStopReason(stopReason) {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'guardrail_intervened':
    case 'content_filtered':
      return 'content_filter';
    case 'malformed_model_output':
    case 'malformed_tool_use':
    case 'model_context_window_exceeded':
      return 'error';
    default:
      return stopReason || 'stop';
  }
}

const BedrockAdapter = new BedrockAdapterClass();
export default BedrockAdapter;
