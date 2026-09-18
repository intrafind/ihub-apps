#!/usr/bin/env node

/**
 * Manual Test: Qwant web search (live)
 *
 * The unit suite (`server/tests/qwant-search-provider.test.js`) covers request
 * building, parsing and error mapping against canned responses. This script is
 * the other half: it calls the real API, so it answers the one question the
 * unit tests cannot — whether *this host* can reach Qwant at all.
 *
 * That matters because Qwant fronts its API with DataDome, which answers
 * requests from data-centre IP ranges with a captcha instead of results. On a
 * cloud VM or behind a corporate egress proxy the provider is wired correctly
 * and still returns nothing, so the script names that case explicitly rather
 * than reporting a generic failure.
 *
 * No API key, account or configuration is required.
 *
 * Run: node tests/manual/manual-test-qwant-search.js [search terms] [--language=de]
 */

import { QwantSearchProvider } from '../../server/services/search/qwantProvider.js';

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
const languageArg = args.find(a => a.startsWith('--language='));
const language = languageArg ? languageArg.split('=')[1] : undefined;
const query = args.filter(a => !a.startsWith('--')).join(' ') || 'intrafind ihub apps';

log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'blue');
log('  Qwant Web Search — live connectivity test', 'blue');
log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', 'blue');
log(`Query:    ${query}`, 'gray');
log(`Language: ${language || 'default (en_US)'}\n`, 'gray');

const provider = new QwantSearchProvider();

try {
  const started = Date.now();
  const { results } = await provider.search(query, { language });
  const elapsed = Date.now() - started;

  if (results.length === 0) {
    log(`⚠ Qwant answered in ${elapsed}ms but returned no results.`, 'yellow');
    log('  The request went through — try a broader query.', 'yellow');
    process.exit(0);
  }

  log(`✓ ${results.length} result(s) in ${elapsed}ms\n`, 'green');
  results.forEach((result, i) => {
    log(`${String(i + 1).padStart(2)}. ${result.title}`, 'reset');
    log(`    ${result.url}`, 'blue');
    if (result.description) log(`    ${result.description.slice(0, 160)}`, 'gray');
    if (result.publishedDate) log(`    published: ${result.publishedDate}`, 'gray');
    console.log();
  });

  log('✓ Qwant search is working on this host.', 'green');
} catch (error) {
  log(`✗ Search failed: ${error.message}\n`, 'red');

  if (error.code === 'QWANT_CAPTCHA') {
    log('This is an egress-IP problem, not a configuration problem:', 'yellow');
    log('  • Qwant challenges requests coming from hosting/VPN IP ranges.', 'yellow');
    log('  • The same code typically works from an office or home network.', 'yellow');
    log('  • Use Brave Search (BRAVE_SEARCH_API_KEY) where that is the case.', 'yellow');
  } else if (error.code === 'QWANT_RATE_LIMITED') {
    log('Qwant is rate-limiting this host — wait a moment and retry.', 'yellow');
  } else if (error.code === 'NETWORK_ERROR' || error.code === 'ECONNREFUSED') {
    log('The request never reached Qwant. Check HTTPS_PROXY / NO_PROXY and', 'yellow');
    log('ssl.domainWhitelist + proxy.urlPatterns in platform.json.', 'yellow');
  }

  process.exit(1);
}
