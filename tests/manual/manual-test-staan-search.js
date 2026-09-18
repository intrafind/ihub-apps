#!/usr/bin/env node

/**
 * Manual Test: Staan web search (live)
 *
 * The unit suite (`server/tests/staan-search-provider.test.js`) covers request
 * building, paging, parsing and error mapping against canned responses. This
 * script is the other half: it calls the real API, so it answers the questions
 * the unit tests cannot — whether this host can reach staan.ai, and whether the
 * key this install is configured with is accepted.
 *
 * Needs an API key, from `providers.json` (Admin → Providers → Staan Search) or
 * the `STAAN_API_KEY` environment variable.
 *
 * Run: node tests/manual/manual-test-staan-search.js [search terms] \
 *        [--language=de] [--max-results=20] [--include=example.com,other.com]
 */

import { StaanSearchProvider } from '../../server/services/search/staanProvider.js';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

const args = process.argv.slice(2);
const valueOf = flag => {
  const arg = args.find(a => a.startsWith(`${flag}=`));
  return arg ? arg.split('=').slice(1).join('=') : undefined;
};

const language = valueOf('--language');
const maxResults = Number(valueOf('--max-results')) || 10;
const includeRaw = valueOf('--include');
const excludeRaw = valueOf('--exclude');
const includeDomains = includeRaw ? includeRaw.split(',') : undefined;
const excludeDomains = excludeRaw ? excludeRaw.split(',') : undefined;
const query = args.filter(a => !a.startsWith('--')).join(' ') || 'intrafind ihub apps';

log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'blue');
log('  Staan Web Search — live connectivity test', 'blue');
log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', 'blue');
log(`Query:     ${query}`, 'gray');
log(`Language:  ${language || 'default (en-us)'}`, 'gray');
log(`Max:       ${maxResults}`, 'gray');
if (includeDomains) log(`Include:   ${includeDomains.join(', ')}`, 'gray');
if (excludeDomains) log(`Exclude:   ${excludeDomains.join(', ')}`, 'gray');
console.log();

const provider = new StaanSearchProvider();

if (!provider.isConfigured()) {
  log('✗ No Staan API key configured.\n', 'red');
  log('Set one in Admin → Providers → Staan Search, or export STAAN_API_KEY.', 'yellow');
  process.exit(1);
}

try {
  const started = Date.now();
  const { results } = await provider.search(query, {
    language,
    count: maxResults,
    includeDomains,
    excludeDomains,
    // A cached hit would say "reachable" for a key that has since been revoked,
    // which is the opposite of what this script is for.
    skipCache: true
  });
  const elapsed = Date.now() - started;

  if (results.length === 0) {
    log(`⚠ Staan answered in ${elapsed}ms but returned no results.`, 'yellow');
    log('  The request went through — try a broader query or a wider filter.', 'yellow');
    process.exit(0);
  }

  log(`✓ ${results.length} result(s) in ${elapsed}ms\n`, 'green');
  results.forEach((result, i) => {
    log(`${String(i + 1).padStart(2)}. ${result.title}`, 'reset');
    log(`    ${result.url}`, 'blue');
    if (result.description) log(`    ${result.description.slice(0, 160)}`, 'gray');
    console.log();
  });

  log('✓ Staan search is working on this host.', 'green');
} catch (error) {
  log(`✗ Search failed: ${error.message}\n`, 'red');

  if (error.code === 'STAAN_UNAUTHORIZED') {
    log('The request reached staan.ai — the key was not accepted:', 'yellow');
    log('  • Re-check the key in Admin → Providers → Staan Search.', 'yellow');
    log('  • A key set via STAAN_API_KEY needs a server restart to take effect.', 'yellow');
  } else if (error.code === 'STAAN_RATE_LIMITED') {
    log('Staan is rate-limiting this host — wait a moment and retry.', 'yellow');
  } else if (error.code === 'STAAN_BAD_REQUEST') {
    log('Staan rejected the request itself — try a plain one-word query.', 'yellow');
  } else if (error.code === 'NETWORK_ERROR' || error.code === 'ECONNREFUSED') {
    log('The request never reached Staan. Check HTTPS_PROXY / NO_PROXY and', 'yellow');
    log('ssl.domainWhitelist + proxy.urlPatterns in platform.json.', 'yellow');
  }

  process.exit(1);
}
