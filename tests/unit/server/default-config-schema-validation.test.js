import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';
import { modelConfigSchema } from '../../../server/validators/modelConfigSchema.js';
import { adminProjectSchema } from '../../../server/validators/projectSchema.js';

const repoRoot = process.cwd();
const defaultAppsDir = path.join(repoRoot, 'server/defaults/apps');
const defaultModelsDir = path.join(repoRoot, 'server/defaults/models');
const exampleAppsDir = path.join(repoRoot, 'examples/apps');
const exampleProjectsDir = path.join(repoRoot, 'examples/projects');

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

    // A fresh install ships no enabled chat model and so no default: the first
    // chat model an admin enables becomes the default (ensureOneDefaultModel).
    expect(defaultModelCount).toBeLessThanOrEqual(1);

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

// The cloud models that used to ship as defaults live in examples/models and
// are installed from the iHub Examples marketplace.
describe('example model configs', () => {
  const exampleModelsDir = path.join(repoRoot, 'examples/models');
  const readModel = file => JSON.parse(fs.readFileSync(path.join(exampleModelsDir, file), 'utf8'));

  it('every model the examples catalog lists exists and validates', () => {
    const catalog = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'examples/catalog.json'), 'utf8')
    );
    const problems = catalog.items
      .filter(item => item.type === 'model')
      .flatMap(item => {
        const file = path.join(repoRoot, 'examples', item.source.path);
        if (!fs.existsSync(file)) return [`${item.name}: missing ${item.source.path}`];
        const parsed = modelConfigSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (!parsed.success) return [`${item.name}: ${JSON.stringify(parsed.error.issues)}`];
        return parsed.data.id === item.name ? [] : [`${item.name}: model id ${parsed.data.id}`];
      });
    expect(problems).toEqual([]);
  });

  it('keeps the Anthropic sampling flags and the opt-in Gemini transcription models', () => {
    // Anthropic's newer models reject sampling parameters: every request 400s.
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1']) {
      expect(readModel(`anthropic/${id}.json`).supportsTemperature).toBe(false);
    }
    // Enabling a Gemini transcription model sends audio to Google: never by default.
    for (const id of ['gemini-3.5-transcribe-live', 'gemini-3.5-transcribe']) {
      expect(readModel(`google/${id}.json`).enabled).toBe(false);
    }
  });
});

// The examples are copied into `contents/` by hand, so an outdated one only
// fails once someone installs it. Check them like the defaults.
function readExampleProjectIds() {
  return new Set(
    readDefaultConfigs(exampleProjectsDir).map(({ fileName, config }) => {
      const parsed = adminProjectSchema.safeParse(config);
      if (!parsed.success) {
        throw new Error(`Invalid examples/projects/${fileName}: ${parsed.error.message}`);
      }
      return parsed.data.id;
    })
  );
}

function exampleAppProblems(fileName, config, projectIds) {
  const parsedApp = appConfigSchema.safeParse(config);
  if (!parsedApp.success) return [`${fileName}: ${JSON.stringify(parsedApp.error.issues)}`];
  return (parsedApp.data.projects ?? [])
    .map(link => (typeof link === 'string' ? link : link.id))
    .filter(projectId => !projectIds.has(projectId))
    .map(projectId => `${fileName}: unknown project "${projectId}"`);
}

describe('example app configs', () => {
  it('validate against the app schema and only link example projects', () => {
    const projectIds = readExampleProjectIds();
    const problems = readDefaultConfigs(exampleAppsDir).flatMap(({ fileName, config }) =>
      exampleAppProblems(fileName, config, projectIds)
    );
    expect(problems).toEqual([]);
  });
});
