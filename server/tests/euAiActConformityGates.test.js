// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Invariants of the EU AI Act master switch (step 9): every feature gate sits in
 * the lowest shared function, so no caller can bypass it. With the switch off
 * each runtime entry point is a silent no-op; switched on again it is active.
 *
 * Native-ESM jest. The record is set in the real config cache.
 */
import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import configCache from '../configCache.js';

const FILE = 'config/eu-ai-act-conformity.json';
const ACTOR = { id: 'admin', name: 'Anna Admin' };
const OFF = {
  version: 1,
  enabled: false,
  changedAt: '2026-11-12T09:30:00.000Z',
  changedBy: ACTOR,
  reason: 'Internal research sandbox, no EU users, no public output.',
  statementVersion: 1,
  history: []
};
const ON = { version: 1, enabled: true, history: [] };
const setSwitch = on => configCache.setCacheEntry(FILE, on ? ON : OFF);

const { isEuAiActEnabled } = await import('../services/euAiAct/conformity.js');
const guardrail = await import('../services/provenance/guardrail.js');
const http = await import('../services/provenance/httpProvenance.js');
const { recordTextOutput } = await import('../services/provenance/turnProvenance.js');
const { stampGeneratedImage, recordGeneratedImage } =
  await import('../services/provenance/mediaMarking.js');
const { BaseAdapter } = await import('../adapters/BaseAdapter.js');
const { setActiveKeyIdSnapshot } =
  await import('../services/provenance/watermark/activeKeySnapshot.js');
const { detectWatermark } = await import('../services/provenance/watermark/detect.js');
const { aiAcknowledgementRequired } = await import('../middleware/aiAcknowledgementRequired.js');
const { getSettings } = await import('../services/aiAcknowledgement/aiAcknowledgementService.js');
const { buildStatus } = await import('../services/euAiAct/statusService.js');

beforeEach(() => {
  setSwitch(true);
  setActiveKeyIdSnapshot('wm-2026-1');
});
afterAll(() => {
  setSwitch(true);
  setActiveKeyIdSnapshot(null);
});

const MESSAGES = [{ role: 'user', content: 'Hello' }];
const VLLM = {
  provider: 'local',
  id: 'm',
  contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel' } },
  sampling: { temperature: 0.8 }
};
const PNG = () => ({
  mimeType: 'image/png',
  data: Buffer.from('not really a png but bytes').toString('base64')
});

describe('with the switch off every entry point is a silent no-op', () => {
  test('the helper agrees', () => {
    expect(isEuAiActEnabled()).toBe(true);
    setSwitch(false);
    expect(isEuAiActEnabled()).toBe(false);
  });

  test('guardrail (also covers LLMClient): messages are returned as they are', () => {
    expect(guardrail.guardMessagesForModel(MESSAGES, { id: 'a' })).not.toBe(MESSAGES);
    setSwitch(false);
    expect(guardrail.guardMessagesForModel(MESSAGES, { id: 'a' })).toBe(MESSAGES);
    setSwitch(true);
    expect(guardrail.guardMessagesForModel(MESSAGES, { id: 'a' })[0].content).toContain(
      'AI system'
    );
  });

  test('wire members: no headers, no provenance member, no MCP/A2A metadata', () => {
    const provenance = { outputId: 'o1' };
    const headers = {};
    const res = { headersSent: false, setHeader: (k, v) => (headers[k] = v) };
    http.applyProvenanceHeaders(res, 'o1');
    expect(headers).toEqual({ 'X-AI-Generated': 'true', 'X-AI-Content-Id': 'o1' });
    expect(http.withProvenance({ a: 1 }, provenance)).toEqual({ a: 1, provenance });
    expect(http.mcpMeta(provenance, { x: 1 })).toEqual({ x: 1, provenance });
    expect(http.a2aMetadata(provenance, undefined)).toEqual({ provenance });

    setSwitch(false);
    const offHeaders = {};
    http.applyProvenanceHeaders(
      { headersSent: false, setHeader: (k, v) => (offHeaders[k] = v) },
      'o1'
    );
    expect(offHeaders).toEqual({});
    const body = { a: 1 };
    expect(http.withProvenance(body, provenance)).toBe(body);
    expect(http.mcpMeta(provenance, { x: 1 })).toEqual({ x: 1 });
    expect(http.mcpMeta(provenance, undefined)).toBeUndefined();
    expect(http.a2aMetadata(provenance, undefined)).toBeUndefined();
  });

  test('a text record is not made', async () => {
    setSwitch(false);
    expect(await recordTextOutput({ text: 'An answer.', model: { id: 'm' } })).toBeNull();
  });

  test('the watermark request flag, plan and claim', () => {
    const adapter = new BaseAdapter();
    const on = adapter.applyTextWatermark({}, VLLM, {}, { temperature: 0.8 });
    expect(on?.text).toMatchObject({ applied: true, keyId: 'wm-2026-1' });
    setSwitch(false);
    const body = {};
    expect(adapter.applyTextWatermark(body, VLLM, {}, { temperature: 0.8 })).toBeUndefined();
    expect(body.watermarking).toBeUndefined();
  });

  test('image stamp and record; the bytes are untouched in both states', async () => {
    const onImage = PNG();
    const before = onImage.data;
    expect(stampGeneratedImage(onImage)?.created).toBe(true);
    expect(onImage.data).toBe(before);
    setSwitch(false);
    const offImage = PNG();
    expect(stampGeneratedImage(offImage)).toBeNull();
    expect(offImage.provenance).toBeUndefined();
    expect(offImage.data).toBe(PNG().data);
    expect(await recordGeneratedImage({ ...onImage }, { model: { id: 'm' } })).toBeNull();
  });

  test('the detector client sends nothing', async () => {
    setSwitch(false);
    const result = await detectWatermark('Some text to look at.');
    expect(result.status).toBe('not_configured');
  });

  test('acknowledgement: the guard calls next() without a users read; configuredEnabled stays', async () => {
    const platform = { aiAcknowledgement: { enabled: true, enforce: true } };
    expect(getSettings(platform)).toMatchObject({ enabled: true, configuredEnabled: true });
    setSwitch(false);
    expect(getSettings(platform)).toMatchObject({ enabled: false, configuredEnabled: true });
    const next = jest.fn();
    await aiAcknowledgementRequired({ user: { id: 'u1' }, headers: {} }, {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  test('status: no checks, no probe, the record is shown', async () => {
    const probe = jest.fn(async () => new Map());
    const platform = { aiAcknowledgement: { enabled: true, enforce: true } };
    const deps = {
      platform,
      models: [],
      probe,
      acknowledgementSummary: () => ({
        enabled: false,
        configuredEnabled: true,
        enforce: true,
        requiredVersion: 1,
        acknowledged: 2,
        pending: 1,
        total: 3
      }),
      selfTests: {}
    };
    setSwitch(false);
    const off = await buildStatus({ deps });
    expect(probe).not.toHaveBeenCalled();
    expect(off).toMatchObject({
      conformity: { enabled: false, changedBy: ACTOR },
      summary: { level: 'disabled' },
      checks: [],
      models: [],
      acknowledgements: { enabled: false, configuredEnabled: true, counts: { acknowledged: 2 } }
    });
    setSwitch(true);
    const on = await buildStatus({ deps });
    expect(on.conformity.enabled).toBe(true);
    expect(on.summary.level).not.toBe('disabled');
  });
});

describe('static invariants', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sources = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', 'defaults', 'contents', 'migrations'].includes(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const code = fs
          .readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        sources.push({ rel: path.relative(root, full), code });
      }
    }
  };
  walk(root);
  const referencing = re =>
    sources
      .filter(s => re.test(s.code))
      .map(s => s.rel)
      .sort();

  test('only conformity.js and the cache touch the record file', () => {
    expect(referencing(/eu-ai-act-conformity\.json|getEuAiActConformity/)).toEqual([
      'configCache.js',
      'services/euAiAct/conformity.js'
    ]);
  });

  test('the ungated primitives are used only by their gated wrappers', () => {
    const allowed = [
      'adapters/BaseAdapter.js',
      'services/provenance/guardrail.js',
      'services/provenance/mediaMarking.js',
      'services/provenance/records.js',
      'services/provenance/turnProvenance.js',
      'services/provenance/watermark/watermarkPlan.js'
    ];
    const offenders = referencing(
      /applyAiDisclosureGuardrail|appendRuleToText|planTextWatermark|buildProvenance\b|buildMediaRecord/
    ).filter(rel => !allowed.includes(rel));
    expect(offenders).toEqual([]);
  });

  test('each gate point still imports the switch', () => {
    const gates = [
      'services/provenance/guardrail.js',
      'services/provenance/turnProvenance.js',
      'services/provenance/httpProvenance.js',
      'services/provenance/mediaMarking.js',
      'services/provenance/watermark/detect.js',
      'services/aiAcknowledgement/aiAcknowledgementService.js',
      'adapters/BaseAdapter.js',
      // `aiDisclosureClientConfig` (first-turn notice) and the public `euAiAct` member
      'routes/chat/dataRoutes.js'
    ];
    for (const rel of gates) {
      const source = sources.find(s => s.rel === rel);
      expect(source?.code).toMatch(/isEuAiActEnabled/);
    }
    for (const rel of ['routes/provenanceRoutes.js', 'routes/admin/watermarkDetectors.js']) {
      expect(sources.find(s => s.rel === rel)?.code).toMatch(/requireEuAiActEnabled\(/);
    }
    expect(sources.find(s => s.rel === 'services/euAiAct/statusService.js')?.code).toMatch(
      /getConformity/
    );
  });

  test('the retention sweep and key management are not gated (data is kept and manageable)', () => {
    for (const rel of [
      'services/provenance/provenanceRetention.js',
      'services/provenance/watermark/WatermarkKeyStore.js',
      'routes/admin/watermarkKeys.js'
    ]) {
      const source = sources.find(s => s.rel === rel);
      if (source) expect(source.code).not.toMatch(/isEuAiActEnabled|requireEuAiActEnabled/);
    }
  });
});
