/**
 * What the marketplace installer refuses to write, and what it keeps.
 *
 * - Content is validated with the same Zod schemas the loaders use. The old
 *   validators imported `validateAppConfig` / `validateModelConfig`, which no
 *   module exports, so every app and model was accepted unchecked.
 * - An item that already exists on the instance without having been installed
 *   from the marketplace (a shipped default, a hand-made file) is not
 *   overwritten unless the caller confirms with `replaceLocal`.
 * - A model written over an existing one keeps that one's encrypted `apiKey`
 *   and `default` flag.
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const state = {
  rootDir: os.tmpdir(),
  /** Catalog item content served by the fake registry, keyed by `type:name`. */
  content: {},
  /** What the fake ConfigCache reports as loaded, per type. */
  loaded: { apps: [], models: [], prompts: [], workflows: [], skills: [] },
  installations: { installations: {} }
};

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getInstallations: () => ({ data: state.installations }),
    refreshInstallationsCache: async () => {},
    getApps: () => ({ data: state.loaded.apps }),
    getModels: () => ({ data: state.loaded.models }),
    getPrompts: () => ({ data: state.loaded.prompts }),
    getWorkflows: () => ({ data: state.loaded.workflows }),
    getSkills: () => ({ data: state.loaded.skills }),
    refreshAppsCache: async () => {},
    refreshModelsCache: async () => {}
  }
}));

jest.unstable_mockModule('../services/marketplace/RegistryService.js', () => ({
  default: {
    getRegistryWithAuth: async () => ({ id: 'reg', auth: { type: 'none' } }),
    getCachedCatalogAsync: async () => ({
      catalog: {
        items: Object.keys(state.content).map(key => {
          const [type, name] = key.split(':');
          return { type, name, version: '1.0.0', source: { type: 'relative', path: key } };
        })
      }
    }),
    resolveItemUrl: item => `https://registry.example/${item.type}/${item.name}`
  }
}));

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: async (_id, url) => {
    const [type, name] = url.split('/').slice(-2);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(state.content[`${type}:${name}`])
    };
  }
}));

const { default: contentInstaller } = await import('../services/marketplace/ContentInstaller.js');

const contentsPath = rel => path.join(state.rootDir, 'contents', rel);
const readContents = async rel => JSON.parse(await fs.readFile(contentsPath(rel), 'utf8'));
const writeContents = async (rel, data) => {
  await fs.mkdir(path.dirname(contentsPath(rel)), { recursive: true });
  await fs.writeFile(contentsPath(rel), JSON.stringify(data, null, 2));
};

const validApp = {
  id: 'note-assistant',
  name: { en: 'Note assistant' },
  description: { en: 'Writes notes' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  system: { en: 'You write notes.' }
};

const validModel = {
  id: 'gemini-flash-latest',
  modelId: 'gemini-flash-latest',
  name: { en: 'Gemini Flash (latest)' },
  description: { en: 'Fast model' },
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent',
  provider: 'google',
  enabled: true,
  default: true
};

describe('ContentInstaller install guards', () => {
  beforeEach(async () => {
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-install-guards-'));
    for (const dir of ['config', 'apps', 'models']) {
      await fs.mkdir(contentsPath(dir), { recursive: true });
    }
    state.content = {};
    state.loaded = { apps: [], models: [], prompts: [], workflows: [], skills: [] };
    state.installations = { installations: {} };
  });

  afterEach(async () => {
    await fs.rm(state.rootDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    test('rejects an app with a key the strict app schema does not allow', async () => {
      state.content['app:note-assistant'] = { ...validApp, tokenLimit: 4096 };

      await expect(contentInstaller.install('reg', 'app', 'note-assistant')).rejects.toThrow(
        /Content validation failed: .*tokenLimit/
      );
      await expect(fs.access(contentsPath('apps/note-assistant.json'))).rejects.toThrow();
    });

    test('rejects a model on the retired thinking.budget shape', async () => {
      state.content['model:gemini-flash-latest'] = {
        ...validModel,
        thinking: { enabled: true, budget: -1 }
      };

      await expect(contentInstaller.install('reg', 'model', 'gemini-flash-latest')).rejects.toThrow(
        /Content validation failed: thinking/
      );
    });

    test('rejects content whose id differs from its catalog name', async () => {
      state.content['app:note-assistant'] = { ...validApp, id: 'Note-assistant' };

      await expect(contentInstaller.install('reg', 'app', 'note-assistant')).rejects.toThrow(
        /id: 'Note-assistant' does not match the catalog name 'note-assistant'/
      );
    });

    test('installs valid content and records it', async () => {
      state.content['app:note-assistant'] = validApp;

      const manifest = await contentInstaller.install('reg', 'app', 'note-assistant', 'admin');

      expect(manifest).toMatchObject({ type: 'app', itemId: 'note-assistant', version: '1.0.0' });
      expect(await readContents('apps/note-assistant.json')).toEqual(validApp);
    });
  });

  describe('local copies', () => {
    test('refuses to overwrite a local item that the marketplace did not install', async () => {
      const localApp = { ...validApp, system: { en: 'My own prompt.' } };
      await writeContents('apps/note-assistant.json', localApp);
      state.loaded.apps = [localApp];
      state.content['app:note-assistant'] = validApp;

      await expect(contentInstaller.install('reg', 'app', 'note-assistant')).rejects.toMatchObject({
        code: 'LOCAL_CONTENT_EXISTS'
      });
      expect(await readContents('apps/note-assistant.json')).toEqual(localApp);
    });

    test('replaces a local item when confirmed, without leaving the id in two files', async () => {
      const localApp = { ...validApp, system: { en: 'My own prompt.' } };
      await writeContents('apps/my-notes.json', localApp);
      state.loaded.apps = [localApp];
      state.content['app:note-assistant'] = validApp;

      await contentInstaller.install('reg', 'app', 'note-assistant', 'admin', {
        replaceLocal: true
      });

      expect(await readContents('apps/note-assistant.json')).toEqual(validApp);
      await expect(fs.access(contentsPath('apps/my-notes.json'))).rejects.toThrow();
    });

    test('a replaced model keeps its API key and default flag', async () => {
      await writeContents('models/gemini-flash-latest.json', {
        ...validModel,
        default: false,
        apiKey: 'encrypted-local-key'
      });
      state.loaded.models = [{ ...validModel, default: false }];
      state.content['model:gemini-flash-latest'] = { ...validModel, default: true };

      await contentInstaller.install('reg', 'model', 'gemini-flash-latest', 'admin', {
        replaceLocal: true
      });

      const written = await readContents('models/gemini-flash-latest.json');
      expect(written.apiKey).toBe('encrypted-local-key');
      expect(written.default).toBe(false);
    });

    test('a newly installed model never becomes the system default', async () => {
      state.content['model:gemini-flash-latest'] = {
        ...validModel,
        default: true,
        apiKey: 'shipped-in-catalog'
      };

      await contentInstaller.install('reg', 'model', 'gemini-flash-latest');

      const written = await readContents('models/gemini-flash-latest.json');
      expect(written.default).toBe(false);
      expect(written.apiKey).toBeUndefined();
    });
  });
});
