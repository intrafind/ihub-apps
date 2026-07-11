/**
 * Shared message formatting for OpenAI-compatible chat completion APIs
 * (OpenAI itself, and vLLM's OpenAI-compatible endpoint).
 *
 * Deliberately a standalone module rather than a shared base class: OpenAI's
 * adapter transitively depends on the full adapter registry (via
 * ModelDiscoveryService -> requestThrottler -> configCache -> ApiKeyVerifier
 * -> utils.js -> adapters/index.js, which imports every adapter including
 * vLLM's). Having vLLM's adapter import anything from OpenAI's adapter module
 * closes that into a circular import and crashes at load time
 * ("Cannot access 'OpenAIAdapterClass' before initialization"). Keeping the
 * shared logic here, with no dependency on either adapter module, avoids the
 * cycle entirely.
 */
import { withSerializedToolArguments } from './toolCalling/GenericToolCalling.js';
import {
  modelConsumesThoughtSignature,
  stripThoughtSignatureExtraContent
} from './toolCalling/thoughtSignatures.js';

/**
 * Map audio MIME type to OpenAI-compatible format string
 * @param {string} mimeType - MIME type (e.g., 'audio/wav', 'audio/mpeg')
 * @returns {string} Format string (e.g., 'wav', 'mp3')
 */
export function getOpenAICompatibleAudioFormat(mimeType) {
  const formatMap = {
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'audio/webm': 'webm'
  };
  return formatMap[mimeType] || 'mp3';
}

/**
 * Format messages for an OpenAI-compatible chat completions API, including
 * image and audio attachments.
 * @param {Array} messages - Messages to format
 * @param {Object} model - Target model config (decides whether a Gemini thought
 *   signature on replayed tool calls is kept or stripped)
 * @param {import('./BaseAdapter.js').BaseAdapter} adapter - Adapter instance,
 *   used for its `hasImageData`/`hasAudioData`/`cleanBase64Data` helpers
 * @returns {Array} Formatted messages
 */
export function formatOpenAICompatibleMessages(messages, model, adapter) {
  const keepExtraContent = modelConsumesThoughtSignature(model);
  return messages.map(message => {
    const content = message.content;

    // Base message with role and optional tool fields
    const base = { role: message.role };
    // Gemini's `extra_content` thought signature is a Google vendor extension.
    // Strict OpenAI-compatible providers reject a request that carries it, so
    // drop it unless this model is the one that consumes it — a caller
    // replaying Gemini-originated history against another model must not have
    // that field forwarded upstream. A call made without arguments goes back
    // as `{}`: strict servers (Ollama) reject `"arguments": ""`.
    if (message.tool_calls) {
      base.tool_calls = withSerializedToolArguments(
        keepExtraContent
          ? message.tool_calls
          : stripThoughtSignatureExtraContent(message.tool_calls)
      );
    }
    if (message.tool_call_id) base.tool_call_id = message.tool_call_id;
    if (message.name) base.name = message.name;

    const hasImages = adapter.hasImageData(message);
    const hasAudio = adapter.hasAudioData(message);

    // No media attachments — return plain content
    if (!hasImages && !hasAudio) {
      const finalContent =
        base.tool_calls && (content === undefined || content === '') ? null : content;
      return { ...base, content: finalContent };
    }

    // Build multipart content array for messages with media
    const contentParts = content ? [{ type: 'text', text: content }] : [];

    // Add image parts. The Office / chat client sends `imageData` as an array;
    // a legacy single image arrives as an object. Raw base64 isn't a valid
    // `image_url.url`, so both shapes are wrapped in a `data:<mime>;base64,…`
    // URL (issue #1467).
    if (hasImages) {
      if (Array.isArray(message.imageData)) {
        message.imageData
          .filter(img => img && img.base64)
          .forEach(img => {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${img.fileType || 'image/jpeg'};base64,${adapter.cleanBase64Data(img.base64)}`,
                detail: 'high'
              }
            });
          });
      } else {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${message.imageData.format || message.imageData.fileType || 'image/jpeg'};base64,${adapter.cleanBase64Data(message.imageData.base64)}`,
            detail: 'high'
          }
        });
      }
    }

    // Add audio parts
    if (hasAudio) {
      if (Array.isArray(message.audioData)) {
        message.audioData
          .filter(audio => audio && audio.base64)
          .forEach(audio => {
            contentParts.push({
              type: 'input_audio',
              input_audio: {
                data: adapter.cleanBase64Data(audio.base64),
                format: getOpenAICompatibleAudioFormat(audio.fileType)
              }
            });
          });
      } else {
        contentParts.push({
          type: 'input_audio',
          input_audio: {
            data: adapter.cleanBase64Data(message.audioData.base64),
            format: getOpenAICompatibleAudioFormat(message.audioData.fileType)
          }
        });
      }
    }

    return { ...base, content: contentParts };
  });
}
