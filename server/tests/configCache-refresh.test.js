// Plain-node test (node server/tests/configCache-refresh.test.js).
//
// Regression test for #1707: configCache's per-key refresh timer only got
// re-armed inside setCacheEntry(), which several refreshCacheEntry() branches
// skip when the freshly-loaded data's ETag matches the cached one — so after
// one "unchanged" cycle, that config key never refreshed again. The ETag
// comparison itself was also broken: it hashed the raw, unresolved reload
// against an ETag computed from resolved (env-var-substituted) data, so any
// config with a `${VAR}`-style placeholder (platform.json ships with
// `deployment.environment: "${NODE_ENV:-production}"`) never matched and
// reloaded on every single tick instead.
import { performInitialSetup } from '../utils/setupUtils.js';
import configCache from '../configCache.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

async function run() {
  // Populate contents/ from server/defaults so apps.json / platform.json etc.
  // are available to load, same as a fresh dev checkout.
  await performInitialSetup();
  configCache.clear();

  // --- Root cause 1: timer must re-arm even when a refresh finds no change ---
  const appsKey = 'config/apps.json';
  await configCache.refreshCacheEntry(appsKey);
  const firstTimer = configCache.refreshTimers.get(appsKey);
  const firstEtag = configCache.cache.get(appsKey)?.etag;
  check('apps cached after first refresh', !!firstEtag);
  check('timer armed after first refresh', !!firstTimer);

  await configCache.refreshCacheEntry(appsKey);
  const secondTimer = configCache.refreshTimers.get(appsKey);
  const secondEtag = configCache.cache.get(appsKey)?.etag;

  check(
    'apps etag unchanged across two refreshes with no underlying edits',
    secondEtag === firstEtag,
    `first=${firstEtag} second=${secondEtag}`
  );
  check(
    'refresh timer is re-armed even when the reload is a no-op',
    !!secondTimer && secondTimer !== firstTimer
  );

  // --- Root cause 2: ETag comparison must use the same (resolved) representation ---
  const platformKey = 'config/platform.json';
  await configCache.refreshCacheEntry(platformKey);
  const platformFirstEtag = configCache.cache.get(platformKey)?.etag;
  check('platform config cached with a templated field', !!platformFirstEtag);

  await configCache.refreshCacheEntry(platformKey);
  const platformSecondEtag = configCache.cache.get(platformKey)?.etag;
  check(
    'platform.json etag is stable despite ${VAR} placeholders (raw vs. resolved no longer mismatch)',
    platformSecondEtag === platformFirstEtag,
    `first=${platformFirstEtag} second=${platformSecondEtag}`
  );

  // --- resolveForCache helper: comparison etag matches what setCacheEntry stores ---
  const sampleKey = 'config/models.json';
  const sample = [{ id: 'test-model', apiKey: '${SOME_TEST_ENV_VAR}' }];
  process.env.SOME_TEST_ENV_VAR = 'resolved-value';
  try {
    configCache.setCacheEntry(sampleKey, sample);
    const stored = configCache.cache.get(sampleKey);
    const { etag: recomputed } = configCache.resolveForCache(sampleKey, sample);
    check(
      'resolveForCache reproduces the etag setCacheEntry stored for the same raw input',
      recomputed === stored.etag
    );
    check(
      'setCacheEntry actually resolved the ${VAR} placeholder',
      stored.data[0].apiKey === 'resolved-value',
      JSON.stringify(stored.data)
    );
  } finally {
    delete process.env.SOME_TEST_ENV_VAR;
  }

  // Sanity check that clear() tears everything down cleanly.
  configCache.clear();
  check('clear() removes all refresh timers', configCache.refreshTimers.size === 0);
  check('clear() empties the cache', configCache.cache.size === 0);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nAll configCache refresh checks passed');
  }
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
