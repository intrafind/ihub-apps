import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';
import { modelConfigSchema } from '../../../server/validators/modelConfigSchema.js';
import { sourcesArraySchema } from '../../../server/validators/sourceConfigSchema.js';

const repoRoot = process.cwd();
const defaultAppsDir = path.join(repoRoot, 'server/defaults/apps');
const defaultModelsDir = path.join(repoRoot, 'server/defaults/models');
const exampleAppsDir = path.join(repoRoot, 'examples/apps');
const exampleSourcesFile = path.join(repoRoot, 'examples/config/sources.json');

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

// The examples are copied into `contents/` by hand, so an outdated one only
// fails once someone installs it. Check them like the defaults.
function readExampleSourceIds() {
  const parsed = sourcesArraySchema.safeParse(
    JSON.parse(fs.readFileSync(exampleSourcesFile, 'utf8'))
  );
  if (!parsed.success) {
    throw new Error(`Invalid examples/config/sources.json: ${parsed.error.message}`);
  }
  return new Set(parsed.data.map(source => source.id));
}

function exampleAppProblems(fileName, config, sourceIds) {
  const parsedApp = appConfigSchema.safeParse(config);
  if (!parsedApp.success) return [`${fileName}: ${JSON.stringify(parsedApp.error.issues)}`];
  return (parsedApp.data.sources ?? [])
    .filter(sourceId => !sourceIds.has(sourceId))
    .map(sourceId => `${fileName}: unknown source "${sourceId}"`);
}

describe('example app configs', () => {
  it('validate against the app schema and only reference example sources', () => {
    const sourceIds = readExampleSourceIds();
    const problems = readDefaultConfigs(exampleAppsDir).flatMap(({ fileName, config }) =>
      exampleAppProblems(fileName, config, sourceIds)
    );
    expect(problems).toEqual([]);
  });
});
