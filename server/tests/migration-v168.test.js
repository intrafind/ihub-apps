#!/usr/bin/env node

/**
 * Migration V168 specs — adds the voice mode platform defaults
 * (`speech.voiceMode`, issue #2868) without touching what an admin set.
 *
 * Run: node --test server/tests/migration-v168.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setDefault } from '../migrations/utils.js';
import {
  up,
  precondition,
  version,
  description
} from '../migrations/V168__add_voice_mode_defaults.js';
import { VOICE_MODE_DEFAULTS } from '../../shared/voiceMode.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';

const PLATFORM = 'config/platform.json';

const DEFAULTS = {
  enabled: false,
  appDefault: false,
  ttsModelId: '',
  listeningStyle: 'hands-free',
  bargeIn: true,
  endOfTurnSilenceMs: 800,
  thinkingLevel: 'low',
  maxSessionMinutes: 30,
  systemPrompt: {}
};

function fakeCtx(files) {
  const logs = [];
  const warnings = [];
  const writes = [];
  return {
    files,
    logs,
    warnings,
    writes,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, data) => {
      writes.push(p);
      files[p] = data;
    },
    setDefault,
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

test('version and description match the file name', () => {
  assert.equal(version, '168');
  assert.equal(description, 'add_voice_mode_defaults');
});

test('precondition requires platform.json', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ [PLATFORM]: {} })), true);
});

test('adds the voice mode defaults next to the other speech settings', async () => {
  const ctx = fakeCtx({
    [PLATFORM]: {
      defaultLanguage: 'de',
      speech: {
        defaultService: 'model',
        tts: { enabled: true, defaultModelId: 'voxtral-mini-tts' }
      }
    }
  });
  await up(ctx);

  const platform = ctx.files[PLATFORM];
  assert.deepEqual(platform.speech.voiceMode, DEFAULTS);
  // Everything else is untouched.
  assert.equal(platform.defaultLanguage, 'de');
  assert.equal(platform.speech.defaultService, 'model');
  assert.deepEqual(platform.speech.tts, { enabled: true, defaultModelId: 'voxtral-mini-tts' });
});

test('voice mode ships switched off', async () => {
  const ctx = fakeCtx({ [PLATFORM]: { speech: {} } });
  await up(ctx);
  assert.equal(ctx.files[PLATFORM].speech.voiceMode.enabled, false);
  assert.equal(ctx.files[PLATFORM].speech.voiceMode.appDefault, false);
});

test('creates the speech block on a platform.json without one', async () => {
  const ctx = fakeCtx({ [PLATFORM]: { defaultLanguage: 'en' } });
  await up(ctx);
  assert.deepEqual(ctx.files[PLATFORM], {
    defaultLanguage: 'en',
    speech: { voiceMode: DEFAULTS }
  });
});

test('keeps every value an admin already set', async () => {
  const admin = {
    enabled: true,
    appDefault: true,
    ttsModelId: 'my-tts',
    listeningStyle: 'push-to-talk',
    bargeIn: false,
    endOfTurnSilenceMs: 1500,
    thinkingLevel: 'medium',
    maxSessionMinutes: 90,
    systemPrompt: { en: 'Be brief.', de: 'Fasse dich kurz.' }
  };
  const ctx = fakeCtx({ [PLATFORM]: { speech: { voiceMode: structuredClone(admin) } } });
  await up(ctx);

  assert.deepEqual(ctx.files[PLATFORM].speech.voiceMode, admin);
  // Nothing was missing, so nothing was written.
  assert.deepEqual(ctx.writes, []);
});

test('keeps values that look unset but are set, such as false, 0, "" and {}', async () => {
  const set = {
    enabled: false,
    appDefault: false,
    ttsModelId: '',
    bargeIn: false,
    endOfTurnSilenceMs: 0,
    systemPrompt: {}
  };
  const ctx = fakeCtx({ [PLATFORM]: { speech: { voiceMode: { ...set } } } });
  await up(ctx);

  const voiceMode = ctx.files[PLATFORM].speech.voiceMode;
  for (const [key, value] of Object.entries(set)) assert.deepEqual(voiceMode[key], value, key);
  // The missing ones are filled in.
  assert.equal(voiceMode.listeningStyle, 'hands-free');
  assert.equal(voiceMode.thinkingLevel, 'low');
  assert.equal(voiceMode.maxSessionMinutes, 30);
});

test('fills in only what is missing from a partial block', async () => {
  const ctx = fakeCtx({
    [PLATFORM]: { speech: { voiceMode: { enabled: true, ttsModelId: 'my-tts' } } }
  });
  await up(ctx);

  assert.deepEqual(ctx.files[PLATFORM].speech.voiceMode, {
    ...DEFAULTS,
    enabled: true,
    ttsModelId: 'my-tts'
  });
});

test('keeps settings of voice mode it does not know about', async () => {
  const ctx = fakeCtx({ [PLATFORM]: { speech: { voiceMode: { future: { x: 1 } } } } });
  await up(ctx);
  assert.deepEqual(ctx.files[PLATFORM].speech.voiceMode.future, { x: 1 });
});

test('running it again changes nothing', async () => {
  const ctx = fakeCtx({ [PLATFORM]: { speech: { defaultService: 'browser' } } });
  await up(ctx);
  const once = structuredClone(ctx.files[PLATFORM]);
  const writesAfterFirst = ctx.writes.length;

  await up(ctx);
  assert.deepEqual(ctx.files[PLATFORM], once);
  assert.equal(ctx.writes.length, writesAfterFirst);
});

test('leaves a speech or voiceMode that is not an object for the admin', async () => {
  for (const speech of ['on', true, 5, ['x']]) {
    const ctx = fakeCtx({ [PLATFORM]: { speech } });
    await up(ctx);
    assert.deepEqual(ctx.files[PLATFORM], { speech });
    assert.equal(ctx.warnings.length, 1);
    assert.deepEqual(ctx.writes, []);
  }
  for (const voiceMode of ['on', true, 5, ['x']]) {
    const ctx = fakeCtx({ [PLATFORM]: { speech: { voiceMode } } });
    await up(ctx);
    assert.deepEqual(ctx.files[PLATFORM], { speech: { voiceMode } });
    assert.equal(ctx.warnings.length, 1);
    assert.deepEqual(ctx.writes, []);
  }
});

test('does not share one object between runs', async () => {
  const first = fakeCtx({ [PLATFORM]: {} });
  const second = fakeCtx({ [PLATFORM]: {} });
  await up(first);
  await up(second);
  first.files[PLATFORM].speech.voiceMode.systemPrompt.en = 'changed';
  assert.deepEqual(second.files[PLATFORM].speech.voiceMode.systemPrompt, {});
});

test('what it writes matches the shipped defaults, the shared defaults and the schema', async () => {
  const ctx = fakeCtx({ [PLATFORM]: {} });
  await up(ctx);
  const written = ctx.files[PLATFORM].speech.voiceMode;

  const shipped = JSON.parse(
    fs.readFileSync(
      fileURLToPath(new URL('../defaults/config/platform.json', import.meta.url)),
      'utf8'
    )
  );
  assert.deepEqual(written, shipped.speech.voiceMode);
  assert.deepEqual(written, VOICE_MODE_DEFAULTS);

  const parsed = platformConfigSchema.safeParse({ speech: { voiceMode: written } });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.speech.voiceMode, written);
});
