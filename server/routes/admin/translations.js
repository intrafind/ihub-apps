// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import configStore from '../../services/config/ConfigStore.js';
import { loadBuiltinLocaleJson } from '../../configLoader.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { authRequired } from '../../middleware/authRequired.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { logAudit } from '../../services/AuditLogService.js';

import { sendErrorResponse } from '../../utils/responseHelpers.js';
const MAX_VALUE_LENGTH = 5000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Flatten a nested locale object to `[{ path, value }]` for every leaf. */
function flatten(node, prefix = [], out = []) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push({ path: prefix, value: node });
    return out;
  }
  for (const [key, value] of Object.entries(node)) flatten(value, [...prefix, key], out);
  return out;
}

/** The string leaf at `path` in `node`, or undefined when there is none. */
function leafAt(node, path) {
  let current = node;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Own, enumerable, writable assignment — never reaches an inherited setter. */
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  });
}

function setAt(root, path, value) {
  if (path.some(segment => FORBIDDEN_SEGMENTS.has(segment))) {
    throw new Error('Forbidden key segment');
  }
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const existing = Object.prototype.hasOwnProperty.call(current, segment)
      ? current[segment]
      : undefined;
    if (existing === null || typeof existing !== 'object') {
      defineOwn(current, segment, {});
    }
    current = current[segment];
  }
  defineOwn(current, path[path.length - 1], value);
}

/** Delete the leaf at `path` and prune the parents that are left empty. */
function removeAt(root, path) {
  const chain = [root];
  for (const segment of path.slice(0, -1)) {
    const next = Object.prototype.hasOwnProperty.call(chain[chain.length - 1], segment)
      ? chain[chain.length - 1][segment]
      : undefined;
    if (next === null || typeof next !== 'object') return;
    chain.push(next);
  }
  delete chain[chain.length - 1][path[path.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length > 0) break;
    delete chain[i - 1][path[i - 1]];
  }
}

const pathKey = path => JSON.stringify(path);
const isPath = path =>
  Array.isArray(path) &&
  path.length > 0 &&
  path.length <= 20 &&
  path.every(
    segment => typeof segment === 'string' && segment.length > 0 && !FORBIDDEN_SEGMENTS.has(segment)
  );

function resolveLanguage(lang) {
  const supported = configCache.getSupportedLanguages();
  return supported.includes(lang) ? lang : null;
}

/**
 * Admin API for translation overrides (`contents/locales/{lang}.json`).
 *
 * The files stay the source of truth, so an override written here is the same
 * thing as one written by hand (docs/localization.md). Only the keys the
 * built-in locale knows can be overridden; unknown keys already in the file are
 * listed (flagged `unknown`) so they can be reset, but cannot be created.
 */
export default function registerAdminTranslationsRoutes(app) {
  /**
   * List/search translations of one language.
   * Query: q (matches key, built-in and overridden text), changedOnly (default
   * true), limit, offset.
   */
  app.get(
    buildServerPath('/api/admin/translations/:lang'),
    authRequired,
    adminAuth,
    async (req, res) => {
      try {
        const language = resolveLanguage(req.params.lang);
        if (!language) return sendErrorResponse(res, 404, 'Unsupported language');

        const base = await loadBuiltinLocaleJson(`${language}.json`);
        if (!base) return sendErrorResponse(res, 500, 'Built-in locale could not be loaded');
        const stored = (await configStore.readJson(`locales/${language}.json`)) || {};

        const overrides = new Map();
        for (const { path, value } of flatten(stored)) {
          if (typeof value === 'string') overrides.set(pathKey(path), { path, value });
        }

        const changedOnly = req.query.changedOnly !== 'false';
        const query = String(req.query.q || '')
          .trim()
          .toLowerCase();
        const limit = Math.min(
          Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1),
          MAX_LIMIT
        );
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const baseKeys = new Set();
        const candidates = [];
        for (const { path, value } of flatten(base)) {
          if (typeof value !== 'string') continue;
          const key = pathKey(path);
          baseKeys.add(key);
          candidates.push({ path, base: value, override: overrides.get(key)?.value ?? null });
        }
        for (const [key, { path, value }] of overrides) {
          if (!baseKeys.has(key)) {
            candidates.push({ path, base: null, override: value, unknown: true });
          }
        }

        const matches = candidates.filter(entry => {
          if (changedOnly && entry.override === null) return false;
          if (!query) return true;
          return (
            entry.path.join('.').toLowerCase().includes(query) ||
            (entry.base || '').toLowerCase().includes(query) ||
            (entry.override || '').toLowerCase().includes(query)
          );
        });

        res.json({
          language,
          languages: configCache.getSupportedLanguages(),
          changedCount: overrides.size,
          total: matches.length,
          entries: matches.slice(offset, offset + limit).map(entry => ({
            ...entry,
            key: entry.path.join('.')
          }))
        });
      } catch (error) {
        logger.error('Error listing translations', { component: 'AdminTranslations', error });
        sendErrorResponse(res, 500, 'Failed to load translations');
      }
    }
  );

  /**
   * Set or reset one override.
   * Body: { path: string[], value: string | null } — null removes the override.
   */
  app.put(
    buildServerPath('/api/admin/translations/:lang'),
    authRequired,
    adminAuth,
    async (req, res) => {
      try {
        const language = resolveLanguage(req.params.lang);
        if (!language) return sendErrorResponse(res, 404, 'Unsupported language');

        const { path, value } = req.body || {};
        if (!isPath(path)) return sendErrorResponse(res, 400, 'Invalid key path');
        const reset = value === null;
        if (!reset && (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH)) {
          return sendErrorResponse(res, 400, 'Value must be a string');
        }

        const base = await loadBuiltinLocaleJson(`${language}.json`);
        if (!base) return sendErrorResponse(res, 500, 'Built-in locale could not be loaded');
        // Resetting is always allowed so stale keys can be cleaned out; setting
        // needs a key the built-in locale actually has.
        if (!reset && leafAt(base, path) === undefined) {
          return sendErrorResponse(res, 400, 'Unknown translation key');
        }

        const relPath = `locales/${language}.json`;
        await configStore.updateJson(relPath, current => {
          const next = current && typeof current === 'object' ? current : {};
          if (reset) removeAt(next, path);
          else setAt(next, path, value);
          return next;
        });
        await configCache.refreshCacheEntry(relPath);

        logAudit({
          req,
          action: 'update',
          resource: 'translation',
          resourceId: `${language}:${path.join('.')}`,
          summary: reset
            ? `Reset translation override ${path.join('.')} (${language})`
            : `Overrode translation ${path.join('.')} (${language})`
        });

        res.json({ success: true });
      } catch (error) {
        logger.error('Error saving translation override', {
          component: 'AdminTranslations',
          error
        });
        sendErrorResponse(res, 500, 'Failed to save translation');
      }
    }
  );
}
