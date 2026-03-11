/**
 * Singleton model cache + lazy loading for in-browser STT engines.
 * Models are loaded on first use and cached for subsequent calls.
 */

export class STTModelNotAvailableError extends Error {
  constructor(service, modelId) {
    super(
      `STT model "${modelId}" (${service}) is not downloaded on this server. Ask an administrator to download it.`
    );
    this.name = 'STTModelNotAvailableError';
    this.service = service;
    this.modelId = modelId;
  }
}

/**
 * Probes the server for a model's availability before attempting to load it.
 * Throws STTModelNotAvailableError if the model files are not present.
 * @param {string} service - 'whisper' | 'parakeet' | 'moonshine'
 * @param {string} modelId - Model identifier
 * @param {string} basePath - Base URL path to model files
 */
async function checkModelAvailability(service, modelId, basePath) {
  let probeUrl;
  switch (service) {
    case 'parakeet':
      probeUrl = `${basePath}/parakeet-tdt-0.6b/vocab.txt`;
      break;
    default:
      probeUrl = `${basePath}/${modelId}/config.json`;
  }

  let response;
  try {
    response = await fetch(probeUrl, { method: 'HEAD' });
  } catch {
    // Network error — let the actual load attempt surface a more specific error
    return;
  }

  if (response.status === 404) {
    throw new STTModelNotAvailableError(service, modelId);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('Authentication required to download STT model files.');
  }
}

const modelCache = new Map();

/**
 * Loads an STT model for the given service, caching it after first load.
 * @param {string} service - 'whisper' | 'parakeet' | 'moonshine'
 * @param {string} modelId - Model identifier (e.g. 'whisper-tiny', 'moonshine-tiny')
 * @param {string} basePath - Base URL path to model files (e.g. '/api/stt-models')
 * @param {function} [onProgress] - Optional progress callback (0-100)
 * @returns {Promise<any>} Loaded model/pipeline instance
 */
export async function loadSTTModel(service, modelId, basePath, onProgress) {
  const cacheKey = `${service}:${modelId}`;
  if (modelCache.has(cacheKey)) {
    return modelCache.get(cacheKey);
  }

  await checkModelAvailability(service, modelId, basePath);

  let model;

  switch (service) {
    case 'whisper': {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Point to self-hosted models, disallow remote fetching
      env.localModelPath = basePath + '/';
      env.allowRemoteModels = false;
      env.allowLocalModels = true;

      const progressCallback = onProgress
        ? progressInfo => {
            if (progressInfo.status === 'progress' && progressInfo.total > 0) {
              onProgress(Math.round((progressInfo.loaded / progressInfo.total) * 100));
            } else if (progressInfo.status === 'done') {
              onProgress(100);
            }
          }
        : undefined;

      model = await pipeline('automatic-speech-recognition', modelId, {
        progress_callback: progressCallback,
        device: 'webgpu' // falls back to wasm automatically if WebGPU unavailable
      });
      break;
    }

    case 'parakeet': {
      const { fromUrls } = await import('parakeet.js');
      const base = `${basePath}/parakeet-tdt-0.6b`;

      // Parakeet doesn't have a standard progress callback; simulate 0 → 100
      onProgress?.(0);
      model = await fromUrls({
        encoderUrl: `${base}/encoder-model.onnx`,
        decoderUrl: `${base}/decoder_joint-model.int8.onnx`,
        tokenizerUrl: `${base}/vocab.txt`,
        backend: 'webgpu-hybrid',
        preprocessorBackend: 'js'
      });
      onProgress?.(100);
      break;
    }

    case 'moonshine': {
      const MoonshineModule = await import('@moonshine-ai/moonshine-js');
      const MicrophoneTranscriber =
        MoonshineModule.MicrophoneTranscriber ||
        MoonshineModule.default?.MicrophoneTranscriber ||
        MoonshineModule.default;
      onProgress?.(0);
      model = new MicrophoneTranscriber(`${basePath}/${modelId}`);
      onProgress?.(100);
      break;
    }

    default:
      throw new Error(`Unknown STT service: ${service}`);
  }

  modelCache.set(cacheKey, model);
  return model;
}

/**
 * Returns true if model for given service+id is already cached.
 * @param {string} service
 * @param {string} modelId
 * @returns {boolean}
 */
export function isModelCached(service, modelId) {
  return modelCache.has(`${service}:${modelId}`);
}

/**
 * Clears the model cache (useful for testing or forced reload).
 */
export function clearModelCache() {
  modelCache.clear();
}
