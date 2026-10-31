// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The built-in web search connector (`com.intrafind/web-search`, installation
 * `websearch`): the Brave, Staan and Qwant search tools and the page reader,
 * with their historical tool ids (`braveSearch`, `staanSearch`, `qwantSearch`,
 * `read_url`). The installation holds the default engine and the API keys
 * (as credential references); which engine an app gets is decided by
 * `toolLoader.resolveWebsearchToolId`, as before.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import braveSearch from '../../../../../../tools/braveSearch.js';
import staanSearch from '../../../../../../tools/staanSearch.js';
import qwantSearch from '../../../../../../tools/qwantSearch.js';
import { extractForTool } from '../../../../../../tools/webContentExtractor.js';
import webSearchService from '../../../../../WebSearchService.js';
import {
  diagnoseSearchError,
  diagnoseSearchSuccess,
  providerLabel
} from '../../../../../search/searchDiagnostics.js';
import {
  resolveBraveApiKey,
  resolveStaanApiKey,
  getWebSearchConfig
} from '../../../../../search/websearchConfig.js';
import { registerThrottleHints } from '../../../../../../requestThrottler.js';

const PARAMETERS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./parameters.json', import.meta.url)), 'utf8')
);

const RUNNERS = { brave: braveSearch, staan: staanSearch, qwant: qwantSearch };

/** The tool call as the search scripts expect it: the model's arguments plus the chat context. */
function searchArgs(args, ctx) {
  return { ...args, chatId: ctx.chatId, language: args.language ?? ctx.params?.language };
}

const actions = {};
for (const [name, spec] of Object.entries(PARAMETERS)) {
  if (spec.concurrency !== undefined || spec.requestDelayMs !== undefined) {
    // The retired tool files carried these; the throttler reads them by tool id.
    registerThrottleHints(spec.toolId, {
      concurrency: spec.concurrency,
      requestDelayMs: spec.requestDelayMs
    });
  }
  actions[name] = {
    parameters: spec.parameters,
    run:
      name === 'readUrl'
        ? (args, ctx) =>
            extractForTool({ ...args, chatId: ctx.chatId, language: ctx.params?.language })
        : (args, ctx) => RUNNERS[name](searchArgs(args, ctx))
  };
}

const TEST_QUERY = 'open source software';
const TEST_TIMEOUT_MS = 20000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The installation test: which engines have a key, then one live search with
 * the default engine (cache bypassed, so a blocked egress IP shows up).
 */
async function test({ values }) {
  const steps = [];
  const brave = Boolean(resolveBraveApiKey());
  const staan = Boolean(resolveStaanApiKey());
  steps.push({
    id: 'keys',
    label: 'API keys',
    status: 'ok',
    message: `Brave: ${brave ? 'key configured' : 'no key'} · Staan: ${staan ? 'key configured' : 'no key'} · Qwant: no key needed`
  });
  const wanted =
    values.defaultProvider && values.defaultProvider !== 'auto' ? values.defaultProvider : null;
  const provider = wanted || (brave ? 'brave' : staan ? 'staan' : 'qwant');
  if ((provider === 'brave' && !brave) || (provider === 'staan' && !staan)) {
    steps.push({
      id: 'search',
      label: `Search with ${providerLabel(provider)}`,
      status: 'fail',
      message: `${providerLabel(provider)} is the default engine but has no API key`
    });
    return steps;
  }
  const started = Date.now();
  try {
    const payload = await withTimeout(
      webSearchService.search(TEST_QUERY, { provider, skipCache: true }),
      TEST_TIMEOUT_MS
    );
    const diagnosis = diagnoseSearchSuccess(payload, provider);
    const results = Array.isArray(payload?.results) ? payload.results : [];
    steps.push({
      id: 'search',
      label: `Search with ${providerLabel(provider)}`,
      status: diagnosis.status === 'ok' ? 'ok' : diagnosis.status === 'error' ? 'fail' : 'warn',
      message: `${diagnosis.title}${diagnosis.detail ? `: ${diagnosis.detail}` : ''} (${results.length} results, ${Date.now() - started} ms)`,
      hints: diagnosis.remediation
    });
  } catch (error) {
    const diagnosis = diagnoseSearchError(error, provider);
    steps.push({
      id: 'search',
      label: `Search with ${providerLabel(provider)}`,
      status: 'fail',
      message: `${diagnosis.title}${diagnosis.detail ? `: ${diagnosis.detail}` : ''}`,
      hints: diagnosis.remediation
    });
  }
  return steps;
}

export default {
  id: 'websearch',
  actions,
  test,
  /** Nothing is cached here; the keys are read on every call. */
  invalidate() {},
  onChanged() {
    // The default engine or a key changed: nothing to drop, the next search reads the installation.
    void getWebSearchConfig();
  }
};
