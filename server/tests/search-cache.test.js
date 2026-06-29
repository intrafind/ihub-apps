// Plain-node test (node server/tests/search-cache.test.js).
//
// Run wf-exec-f4f70e84 fired 151 braveSearch calls against a ~1 req/s free tier
// (all 429'd). Many verify tasks across re-plan rounds re-issue overlapping
// queries. A short-TTL query cache lets repeat queries skip the API entirely —
// fewer calls, fewer 429s. This tests the cache primitive.
import {
  makeSearchCacheKey,
  getCachedSearch,
  setCachedSearch,
  _clearSearchCache
} from '../services/searchCache.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

_clearSearchCache();

// ---- key normalization ----
check(
  'key normalizes case + whitespace',
  makeSearchCacheKey('brave', '  Foo   Bar ') === makeSearchCacheKey('brave', 'foo bar')
);
check(
  'different providers → different keys',
  makeSearchCacheKey('brave', 'x') !== makeSearchCacheKey('tavily', 'x')
);
check(
  'extra opts participate in the key',
  makeSearchCacheKey('brave', 'x', { count: 5 }) !== makeSearchCacheKey('brave', 'x', { count: 10 })
);

// ---- get/set with TTL (now injected for determinism) ----
const k = makeSearchCacheKey('brave', 'darin stewart gartner');
check('miss before set', getCachedSearch(k, 1000) === undefined);

setCachedSearch(k, { results: [{ url: 'a' }] }, 10000, 1000); // expires at 11000
check('hit within TTL', getCachedSearch(k, 5000)?.results?.[0]?.url === 'a');
check('miss after TTL expiry', getCachedSearch(k, 11001) === undefined);
check('expired entry is evicted (miss again)', getCachedSearch(k, 5000) === undefined);

// ---- bounded size: old entries evicted, never grows unbounded ----
_clearSearchCache();
for (let i = 0; i < 1000; i++) setCachedSearch(makeSearchCacheKey('brave', `q${i}`), { results: [] }, 60000, 1000);
// the most recent entry must still be present...
check('recent entry retained under load', getCachedSearch(makeSearchCacheKey('brave', 'q999'), 2000) !== undefined);
// ...and the oldest evicted (cache is bounded)
check('oldest entry evicted under load', getCachedSearch(makeSearchCacheKey('brave', 'q0'), 2000) === undefined);

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
