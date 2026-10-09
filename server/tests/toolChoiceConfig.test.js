/**
 * Where `toolChoice` is configured: an app's `toolChoice`, a workflow node's
 * `config.toolChoice` and a model's `supportsForcedToolUse` capability flag.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigSchema, knownAppKeys } from '../validators/appConfigSchema.js';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';
import { nodeConfigSchema } from '../validators/workflowConfigSchema.js';
import { getRootDir } from '../pathUtils.js';

const app = {
  id: 'research',
  name: { en: 'Research' },
  description: { en: 'Researches' },
  color: '#4F46E5',
  icon: 'search',
  system: { en: 'Research things.' },
  tools: ['read_url']
};

describe('app toolChoice', () => {
  it('accepts auto and required and is optional', () => {
    assert.equal(appConfigSchema.safeParse(app).success, true);
    for (const toolChoice of ['auto', 'required']) {
      const parsed = appConfigSchema.safeParse({ ...app, toolChoice });
      assert.equal(parsed.success, true);
      assert.equal(parsed.data.toolChoice, toolChoice);
    }
  });

  it('rejects anything else', () => {
    for (const toolChoice of ['any', 'none', 'sometimes', true]) {
      assert.equal(
        appConfigSchema.safeParse({ ...app, toolChoice }).success,
        false,
        `${toolChoice}`
      );
    }
  });

  it('is a known app key (kept by the admin editor and inheritance)', () => {
    assert.ok(knownAppKeys.includes('toolChoice'));
  });
});

describe('workflow node toolChoice', () => {
  const node = config => ({
    id: 'agent',
    type: 'prompt',
    name: { en: 'Agent' },
    position: { x: 0, y: 0 },
    config
  });

  it('accepts auto and required', () => {
    for (const toolChoice of ['auto', 'required']) {
      const parsed = nodeConfigSchema.safeParse(node({ toolChoice }));
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
      assert.equal(parsed.data.config.toolChoice, toolChoice);
    }
    assert.equal(nodeConfigSchema.safeParse(node({})).success, true);
  });

  it('rejects anything else', () => {
    assert.equal(nodeConfigSchema.safeParse(node({ toolChoice: 'sometimes' })).success, false);
  });
});

describe('model supportsForcedToolUse', () => {
  const model = {
    id: 'm',
    modelId: 'm',
    name: { en: 'M' },
    description: { en: 'M' },
    url: 'https://example.com/v1/messages',
    provider: 'anthropic'
  };

  it('is an optional boolean', () => {
    assert.equal(modelConfigSchema.safeParse(model).success, true);
    const parsed = modelConfigSchema.safeParse({ ...model, supportsForcedToolUse: false });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.supportsForcedToolUse, false);
    assert.equal(
      modelConfigSchema.safeParse({ ...model, supportsForcedToolUse: 'no' }).success,
      false
    );
  });

  it('is set on the shipped model that rejects forced tool use', () => {
    const fable = JSON.parse(
      fs.readFileSync(
        path.join(getRootDir(), 'server', 'defaults', 'models', 'claude-fable-5-1.json'),
        'utf8'
      )
    );
    assert.equal(fable.supportsForcedToolUse, false);
    assert.equal(modelConfigSchema.safeParse(fable).success, true);
  });
});
