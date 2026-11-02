// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The built-in web search engine connectors: one native connector per engine
 * definition, each with the one action the web search feature calls,
 * `search` (the engine contract, see `services/search/webSearchEngines.js`).
 *
 * | Connector (`protocol.module`) | Definition                   | Installation | Tool id       |
 * | ----------------------------- | ---------------------------- | ------------ | ------------- |
 * | `braveSearch`                 | `com.intrafind/brave-search` | `brave`      | `braveSearch` |
 * | `staanSearch`                 | `com.intrafind/staan-search` | `staan`      | `staanSearch` |
 * | `qwantSearch`                 | `com.intrafind/qwant-search` | `qwant`      | `qwantSearch` |
 *
 * The search runs the shipped scripts (`server/tools/braveSearch.js`, …);
 * their parameters are `parameters.json`, keyed by engine id. Brave and Staan
 * read their API key from the installation's credential reference
 * (`apiKeyRef`), else from the environment variable
 * (`services/search/websearchConfig.js`). Which engine an app gets is decided
 * by the tool loader (`resolveWebSearchEngine`), not here. The page reader
 * (`read_url`) is not an engine action: it belongs to the web search feature
 * (`services/tools/platformTools.js`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import braveSearch from '../../../../../../tools/braveSearch.js';
import staanSearch from '../../../../../../tools/staanSearch.js';
import qwantSearch from '../../../../../../tools/qwantSearch.js';
import webSearchService from '../../../../../WebSearchService.js';
import {
  diagnoseSearchError,
  diagnoseSearchSuccess,
  providerLabel
} from '../../../../../search/searchDiagnostics.js';
import { resolveEngineApiKeyDetails } from '../../../../../search/websearchConfig.js';
import { builtInEngine, WEB_SEARCH_ACTION } from '../../../../../search/webSearchEngines.js';
import { registerThrottleHints } from '../../../../../../requestThrottler.js';

const PARAMETERS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./parameters.json', import.meta.url)), 'utf8')
);

/** The search script of each engine. */
const RUNNERS = Object.freeze({ brave: braveSearch, staan: staanSearch, qwant: qwantSearch });

const TEST_QUERY = 'open source software';
const TEST_TIMEOUT_MS = 20000;

/** The tool call as the search scripts expect it: the model's arguments plus the chat context. */
function searchArgs(args, ctx) {
  return { ...args, chatId: ctx.chatId, language: args.language ?? ctx.params?.language };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The API key step of a keyed engine's test: where the key comes from, from
 * the values under test. A referenced credential without a value is a `warn`
 * when the environment variable stood in (the engine would break once the
 * variable goes) and a `fail` when nothing did.
 *
 * @param {string} engineId
 * @param {Object} values - the install values under test
 * @returns {{ step: Object, key: string|undefined }}
 */
export function apiKeyStep(engineId, values) {
  const engine = builtInEngine(engineId);
  const label = 'API key';
  if (!engine?.keyEnv) {
    return {
      step: { id: 'key', label, status: 'ok', message: `${providerLabel(engineId)} needs no key` },
      key: undefined
    };
  }
  const { key, source, ref, refMissing } = resolveEngineApiKeyDetails(engineId, values || {});
  if (!key) {
    return {
      step: {
        id: 'key',
        label,
        status: 'fail',
        message: refMissing
          ? `Credential "${ref}" has no value or does not exist, and ${engine.keyEnv} is not set`
          : `No API key: pick a credential or set ${engine.keyEnv}`,
        hints: ['Store the key as a credential of type secret and pick it in the API key field']
      },
      key
    };
  }
  if (refMissing) {
    return {
      step: {
        id: 'key',
        label,
        status: 'warn',
        message: `Credential "${ref}" has no value or does not exist; the key came from ${engine.keyEnv}`,
        hints: [
          'Pick a credential that holds the key, or clear the field to use the environment variable on purpose'
        ]
      },
      key
    };
  }
  return {
    step: {
      id: 'key',
      label,
      status: 'ok',
      message:
        source === 'credential' ? `Key from credential "${ref}"` : `Key from ${engine.keyEnv}`
    },
    key
  };
}

/**
 * One live search with the engine (cache bypassed, so a blocked egress IP or
 * a revoked key shows up), with the diagnosis the former connectivity test
 * gave.
 *
 * @param {string} engineId
 * @param {string|undefined} apiKey - the key under test (keyed engines)
 * @returns {Promise<Object>} the step
 */
async function searchStep(engineId, apiKey) {
  const label = `Search with ${providerLabel(engineId)}`;
  const started = Date.now();
  try {
    const payload = await withTimeout(
      webSearchService.search(TEST_QUERY, {
        provider: engineId,
        skipCache: true,
        ...(apiKey ? { apiKey } : {})
      }),
      TEST_TIMEOUT_MS
    );
    const diagnosis = diagnoseSearchSuccess(payload, engineId);
    const results = Array.isArray(payload?.results) ? payload.results : [];
    return {
      id: 'search',
      label,
      status: diagnosis.status === 'ok' ? 'ok' : diagnosis.status === 'error' ? 'fail' : 'warn',
      message: `${diagnosis.title}${diagnosis.detail ? `: ${diagnosis.detail}` : ''} (${results.length} results, ${Date.now() - started} ms)`,
      hints: diagnosis.remediation
    };
  } catch (error) {
    const diagnosis = diagnoseSearchError(error, engineId);
    return {
      id: 'search',
      label,
      status: 'fail',
      message: `${diagnosis.title}${diagnosis.detail ? `: ${diagnosis.detail}` : ''}`,
      hints: diagnosis.remediation
    };
  }
}

/**
 * The native connector of one built-in engine.
 *
 * @param {'brave'|'staan'|'qwant'} engineId
 * @returns {Object} the connector (`id`, `actions.search`, `test`)
 */
export function createEngineConnector(engineId) {
  const spec = PARAMETERS[engineId];
  const run = RUNNERS[engineId];
  if (!spec || !run) throw new Error(`Unknown web search engine "${engineId}"`);
  if (spec.concurrency !== undefined || spec.requestDelayMs !== undefined) {
    // The retired tool files carried these; the throttler reads them by tool id.
    registerThrottleHints(spec.toolId, {
      concurrency: spec.concurrency,
      requestDelayMs: spec.requestDelayMs
    });
  }
  return {
    id: `${engineId}Search`,
    actions: {
      [WEB_SEARCH_ACTION]: {
        parameters: spec.parameters,
        run: (args, ctx) => run(searchArgs(args, ctx))
      }
    },
    /**
     * The installation test, against the values as entered: the API key
     * (keyed engines), then one live search.
     */
    async test({ values }) {
      const { step, key } = apiKeyStep(engineId, values);
      if (step.status === 'fail') return [step];
      return [step, await searchStep(engineId, key)];
    },
    /** Nothing is cached here; the key is read on every call. */
    invalidate() {}
  };
}

export const braveSearchConnector = createEngineConnector('brave');
export const staanSearchConnector = createEngineConnector('staan');
export const qwantSearchConnector = createEngineConnector('qwant');
