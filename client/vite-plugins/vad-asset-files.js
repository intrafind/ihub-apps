/**
 * The files voice mode's voice activity detector (Silero VAD, `@ricky0123/vad-web`
 * on ONNX Runtime Web) loads at runtime, published at `<base>/vad/<name>` by
 * `vite-plugin-vad-assets.js`.
 *
 * Nothing is fetched from a CDN: the library's defaults would pull the model, the
 * audio worklet and the WebAssembly runtime from jsDelivr, which breaks air-gapped
 * and on-premise installs. `client/src/features/voice/utils/voiceSession/
 * vadAssets.js` builds the matching base-path-aware URL.
 *
 * `specifier` is resolved from `client/node_modules`, so the files always match the
 * pinned package versions in `client/package.json`. Kept apart from the plugin so
 * that a unit test can check that every file still exists after a version bump.
 */
export const VAD_ASSET_DIR = 'vad';

export const VAD_ASSETS = [
  // The audio worklet that cuts the microphone into 16 kHz frames for the model.
  {
    name: 'vad.worklet.bundle.min.js',
    specifier: '@ricky0123/vad-web/dist/vad.worklet.bundle.min.js'
  },
  // The Silero VAD v5 model (about 2.3 MB).
  { name: 'silero_vad_v5.onnx', specifier: '@ricky0123/vad-web/dist/silero_vad_v5.onnx' },
  // ONNX Runtime Web's loader and WebAssembly binary (the plain CPU build, about 14 MB).
  { name: 'ort-wasm-simd-threaded.mjs', specifier: 'onnxruntime-web/ort-wasm-simd-threaded.mjs' },
  { name: 'ort-wasm-simd-threaded.wasm', specifier: 'onnxruntime-web/ort-wasm-simd-threaded.wasm' }
];
