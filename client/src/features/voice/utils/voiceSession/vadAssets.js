// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { buildAssetUrl } from '../../../../utils/runtimeBasePath';

/**
 * Where the voice activity detector's files are served from: `<base>/vad/`.
 * The build publishes them there (`client/vite-plugins/vite-plugin-vad-assets.js`:
 * the Silero model, the audio worklet and ONNX Runtime Web's WebAssembly), so
 * nothing is fetched from a CDN. `buildAssetUrl` makes the URL base-path aware
 * (`/ihub/vad/` for a deployment under `/ihub`) and points the Vite dev server
 * at `/vad/`.
 *
 * The URL is made absolute because ONNX Runtime imports its loader module from
 * it, and a relative `import()` resolves against the chunk that runs it, not
 * against the page.
 *
 * @returns {string} Absolute URL ending in `/`.
 */
export function getVadAssetBaseUrl() {
  const path = buildAssetUrl('/vad/');
  try {
    return new URL(path, window.location.href).href;
  } catch {
    return path;
  }
}
