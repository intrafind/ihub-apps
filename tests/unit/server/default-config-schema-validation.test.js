import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';
import { modelConfigSchema } from '../../../server/validators/modelConfigSchema.js';
import { adminProjectSchema } from '../../../server/validators/projectSchema.js';

const repoRoot = process.cwd();
const defaultAppsDir = path.join(repoRoot, 'server/defaults/apps');
const defaultModelsDir = path.join(repoRoot, 'server/defaults/models');
const defaultProjectsDir = path.join(repoRoot, 'server/defaults/projects');
const fixtureModelsDir = path.join(repoRoot, 'server/tests/fixtures/models');

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
    expect(defaultModelCount).toBe(0);

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

// The cloud models that used to ship as defaults live in the iHub marketplace;
// server/tests/fixtures/models keeps copies for the tests that need them.
describe('fixture model configs', () => {
  const readModel = file => JSON.parse(fs.readFileSync(path.join(fixtureModelsDir, file), 'utf8'));
  const fixtureFiles = fs
    .readdirSync(fixtureModelsDir, { recursive: true })
    .filter(file => file.endsWith('.json'));

  it('every fixture model validates and its id matches its file name', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
    const problems = fixtureFiles.flatMap(file => {
      const parsed = modelConfigSchema.safeParse(readModel(file));
      if (!parsed.success) return [`${file}: ${JSON.stringify(parsed.error.issues)}`];
      return `${parsed.data.id}.json` === path.basename(file)
        ? []
        : [`${file}: model id ${parsed.data.id}`];
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

describe('default projects', () => {
  it('validate against the project schema, and apps only link shipped projects', () => {
    const projectIds = new Set(
      readDefaultConfigs(defaultProjectsDir).map(({ fileName, config }) => {
        const parsed = adminProjectSchema.safeParse(config);
        if (!parsed.success) {
          throw new Error(`Invalid default project ${fileName}: ${parsed.error.message}`);
        }
        return parsed.data.id;
      })
    );
    const problems = readDefaultConfigs(defaultAppsDir).flatMap(({ fileName, config }) =>
      (appConfigSchema.parse(config).projects ?? [])
        .map(link => (typeof link === 'string' ? link : link.id))
        .filter(projectId => !projectIds.has(projectId))
        .map(projectId => `${fileName}: unknown project "${projectId}"`)
    );
    expect(problems).toEqual([]);
  });
});
