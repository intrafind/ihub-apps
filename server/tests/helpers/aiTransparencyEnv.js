/**
 * Test environment for the EU AI Act transparency specs: a throw-away
 * contents directory (installation id, keystore, encryption key), and a
 * patchable config cache. Import this module FIRST — it sets CONTENTS_DIR
 * before `config.js` is loaded by anything else.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const tempContents = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-ai-act-'));
process.env.CONTENTS_DIR = path.relative(root, tempContents);

const { default: configCache } = await import('../../configCache.js');
const { default: tokenStorageService } = await import('../../services/TokenStorageService.js');
const { setLogLevel } = await import('../../utils/logger.js');
setLogLevel('error');
await tokenStorageService.initializeEncryptionKey();

const state = { platform: {}, models: [], apps: [], features: {} };
configCache.getPlatform = () => state.platform;
configCache.getModels = () => ({ data: state.models, etag: 'test' });
configCache.getApps = () => ({ data: state.apps, etag: 'test' });
configCache.getFeatures = () => state.features;

/**
 * Replace what the config cache answers.
 * @param {{platform?: Object, models?: Object[], apps?: Object[], features?: Object}} next
 */
export function setConfig(next = {}) {
  if (next.platform !== undefined) state.platform = next.platform;
  if (next.models !== undefined) state.models = next.models;
  if (next.apps !== undefined) state.apps = next.apps;
  if (next.features !== undefined) state.features = next.features;
}

export function cleanup() {
  fs.rmSync(tempContents, { recursive: true, force: true });
}

export { configCache };
