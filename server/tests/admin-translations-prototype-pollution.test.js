// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The translation override routes build and prune nested objects from a key
 * path the client sends. Neither setting nor resetting an override may reach
 * `Object.prototype`.
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const base = { common: { save: 'Save' } };
let stored = null;

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getSupportedLanguages: () => ['en'], refreshCacheEntry: jest.fn() }
}));
jest.unstable_mockModule('../configLoader.js', () => ({
  loadBuiltinLocaleJson: async () => structuredClone(base)
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async () => stored && structuredClone(stored),
    updateJson: async (_p, mutate) => {
      stored = await mutate(stored && structuredClone(stored));
      return { data: stored, written: true };
    }
  }
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (_q, _s, n) => n()
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({ adminAuth: (_q, _s, n) => n() }));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: jest.fn() }));

const { default: register } = await import('../routes/admin/translations.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const app = express();
app.use(express.json());
register(app);
app.use(errorHandler);

const put = body => request(app).put('/api/admin/translations/en').send(body);

beforeEach(() => {
  stored = null;
});

afterEach(() => {
  expect({}.polluted).toBeUndefined();
  expect({}.save).toBeUndefined();
});

describe.each(['__proto__', 'constructor', 'prototype'])('key segment %s', segment => {
  test('is refused when setting an override, at any depth', async () => {
    await put({ path: [segment, 'polluted'], value: 'x' }).expect(400);
    await put({ path: ['common', segment, 'polluted'], value: 'x' }).expect(400);
    await put({ path: ['common', segment], value: 'x' }).expect(400);
    expect(stored).toBeNull();
  });

  test('is refused when resetting an override', async () => {
    stored = { common: { save: 'Store' } };
    await put({ path: [segment, 'polluted'], value: null }).expect(400);
    await put({ path: ['common', segment], value: null }).expect(400);
    expect(stored).toEqual({ common: { save: 'Store' } });
  });
});

test('an own key still sets and resets, and the new objects hold only own keys', async () => {
  await put({ path: ['common', 'save'], value: 'Store' }).expect(204);
  expect(stored).toEqual({ common: { save: 'Store' } });
  await put({ path: ['common', 'save'], value: null }).expect(204);
  expect(stored).toEqual({});
});
