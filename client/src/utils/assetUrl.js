// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where an asset URL points on a deployment under a base path (`/ihub`): the
 * header logo, the favicon, an app's icon. Most of them are configured by an
 * admin, so they come in every form someone may type or paste.
 *
 * Kept apart from runtimeBasePath.js, which reads `import.meta` and cannot be
 * loaded by the unit tests.
 */

// Complete URLs: another origin, an inline image, an object URL, or a
// protocol-relative URL. None of them is a path under the base path.
const COMPLETE_URL = /^(?:https?:|data:image\/|blob:|\/\/)/i;

/**
 * Whether the URL is complete on its own and must be used as it is.
 *
 * @param {string} asset
 * @returns {boolean}
 */
export const isCompleteAssetUrl = asset => typeof asset === 'string' && COMPLETE_URL.test(asset);

/**
 * Resolve an asset path against the deployment's base path.
 *
 * - `/uploads/assets/logo.png` and `uploads/assets/logo.png` → `/ihub/uploads/assets/logo.png`
 * - `/ihub/uploads/assets/logo.png` (the address an admin sees in the browser) stays as it
 *   is; prefixing it again would request `/ihub/ihub/…`, which a proxy that forwards the
 *   prefix answers with a 404.
 * - complete URLs (`https://…`, `data:image/…`, `blob:…`, `//…`) stay as they are.
 *
 * @param {string} asset - The asset path or URL.
 * @param {string} basePath - The deployment's base path (`''` at the root).
 * @returns {string}
 */
export const resolveAssetUrl = (asset, basePath = '') => {
  if (isCompleteAssetUrl(asset)) return asset;
  if (basePath && (asset === basePath || asset.startsWith(`${basePath}/`))) return asset;
  const cleanAsset = asset.startsWith('/') ? asset.substring(1) : asset;
  return basePath ? `${basePath}/${cleanAsset}` : `/${cleanAsset}`;
};
