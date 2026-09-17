import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';
import { modelConfigSchema } from '../../../server/validators/modelConfigSchema.js';

const repoRoot = process.cwd();
const defaultAppsDir = path.join(repoRoot, 'server/defaults/apps');
const defaultModelsDir = path.join(repoRoot, 'server/defaults/models');

function readDefaultConfigs(directoryPath) {
  return fs
    .readdirSync(directoryPath)
    .filter(fileName => fileName.endsWith('.json'))
    .map(fileName => ({
      fileName,
      config: JSON.parse(fs.readFileSync(path.join(directoryPath, fileName), 'utf8'))
    }));
}

describe('default app and model configs', () => {
  it('validate against schemas and only reference shipped models', () => {
    const defaultModels = readDefaultConfigs(defaultModelsDir);
    const modelIds = new Set();
    let defaultModelCount = 0;

    for (const { fileName, config } of defaultModels) {
      const parsedModel = modelConfigSchema.safeParse(config);
      expect(parsedModel.success).toBe(true);
      if (!parsedModel.success) {
        throw new Error(
          `Invalid default model config ${fileName}: ${JSON.stringify(parsedModel.error.issues)}`
        );
      }
      modelIds.add(parsedModel.data.id);
      if (parsedModel.data.default) {
        defaultModelCount += 1;
      }
    }

    expect(defaultModelCount).toBe(1);

    const defaultApps = readDefaultConfigs(defaultAppsDir);
    for (const { fileName, config } of defaultApps) {
      const parsedApp = appConfigSchema.safeParse(config);
      expect(parsedApp.success).toBe(true);
      if (!parsedApp.success) {
        throw new Error(
          `Invalid default app config ${fileName}: ${JSON.stringify(parsedApp.error.issues)}`
        );
      }

      if (parsedApp.data.preferredModel) {
        expect(modelIds.has(parsedApp.data.preferredModel)).toBe(true);
      }
    }
  });
});
