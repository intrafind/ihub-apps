import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Files voice mode's voice activity detector (Silero VAD, `@ricky0123/vad-web`
 * on ONNX Runtime Web) loads at runtime, published at `<base>/vad/<name>`.
 *
 * Nothing is fetched from a CDN: the library's defaults would pull the model,
 * the audio worklet and the WebAssembly runtime from jsDelivr, which breaks
 * air-gapped and on-premise installs. `client/src/features/voice/utils/
 * voiceSession/vadAssets.js` builds the matching base-path-aware URL.
 *
 * `specifier` is resolved from `client/node_modules`, so the files always match
 * the pinned package versions in `client/package.json`.
 */
export const VAD_ASSET_DIR = 'vad';

export const VAD_ASSETS = [
  // The audio worklet that cuts the microphone into 16 kHz frames for the model.
  { name: 'vad.worklet.bundle.min.js', specifier: '@ricky0123/vad-web/dist/vad.worklet.bundle.min.js' },
  // The Silero VAD v5 model (about 2.3 MB).
  { name: 'silero_vad_v5.onnx', specifier: '@ricky0123/vad-web/dist/silero_vad_v5.onnx' },
  // ONNX Runtime Web's loader and WebAssembly binary (the plain CPU build).
  { name: 'ort-wasm-simd-threaded.mjs', specifier: 'onnxruntime-web/ort-wasm-simd-threaded.mjs' },
  { name: 'ort-wasm-simd-threaded.wasm', specifier: 'onnxruntime-web/ort-wasm-simd-threaded.wasm' }
];

const CONTENT_TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream'
};

/** Absolute path of an asset inside node_modules, or null when not installed. */
function resolveAsset(asset) {
  try {
    const path = require.resolve(asset.specifier);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * Vite plugin that publishes the VAD runtime files under `/vad/`: a middleware
 * in `vite dev`, emitted assets (`dist/vad/*`) in `vite build`. The production
 * server serves them as static files like the rest of `dist/`.
 */
export default function vadAssetsPlugin() {
  return {
    name: 'vite-plugin-vad-assets',

    configureServer(server) {
      server.middlewares.use(`/${VAD_ASSET_DIR}`, (req, res, next) => {
        const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
        const asset = VAD_ASSETS.find(candidate => candidate.name === name);
        const path = asset && resolveAsset(asset);
        if (!path) {
          next();
          return;
        }
        res.setHeader('Content-Type', CONTENT_TYPES[extname(name)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(readFileSync(path));
      });
    },

    generateBundle() {
      for (const asset of VAD_ASSETS) {
        const path = resolveAsset(asset);
        if (!path) {
          // Voice mode cannot listen without these: fail the build loudly
          // instead of shipping a button that never works.
          throw new Error(
            `[vad-assets] ${asset.specifier} not found. Run "npm install" in client/ ` +
              '(@ricky0123/vad-web and onnxruntime-web are voice mode dependencies).'
          );
        }
        this.emitFile({
          type: 'asset',
          fileName: `${VAD_ASSET_DIR}/${asset.name}`,
          source: readFileSync(path)
        });
      }
    }
  };
}
