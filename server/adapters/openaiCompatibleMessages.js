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
 * @param {import('./BaseAdapter.js').BaseAdapter} adapter - Adapter instance,
 *   used for its `hasImageData`/`hasAudioData`/`cleanBase64Data` helpers
 * @returns {Array} Formatted messages
 */
export function formatOpenAICompatibleMessages(messages, adapter) {
  return messages.map(message => {
    const content = message.content;

    // Base message with role and optional tool fields
    const base = { role: message.role };
    if (message.tool_calls) base.tool_calls = message.tool_calls;
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

    // Add image parts
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
