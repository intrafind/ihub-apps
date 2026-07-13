#!/usr/bin/env node

/**
 * Tests for resolveSafeReturnUrl, the same-origin guard for post-login
 * redirect targets (LoginPage.jsx, AuthContext.jsx). Without this guard a
 * crafted `?returnUrl=` query parameter causes an open redirect
 * (https://evil.example) or a javascript: URI XSS right after a real login.
 *
 * Run directly: `node client/src/shared/utils/returnUrl.test.js`.
 */

globalThis.window = { location: { origin: 'https://app.example.com' } };

const { resolveSafeReturnUrl } = await import('./returnUrl.js');

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

console.log('🧪 resolveSafeReturnUrl\n');

check(
  'cross-origin URL falls back to default',
  resolveSafeReturnUrl('https://evil.example/phish') === '/'
);

check(
  'javascript: URI falls back to default',
  resolveSafeReturnUrl('javascript:alert(1)') === '/'
);

check('empty value falls back to default', resolveSafeReturnUrl('') === '/');
check('null value falls back to default', resolveSafeReturnUrl(null) === '/');

check(
  'unparseable value falls back to default',
  resolveSafeReturnUrl('http://[::not-a-valid-host') === '/'
);

check(
  'custom fallback is honored',
  resolveSafeReturnUrl('https://evil.example', null) === null
);

check(
  'same-origin absolute path resolves unchanged',
  resolveSafeReturnUrl('/apps/my-app') === 'https://app.example.com/apps/my-app'
);

check(
  'same-origin absolute URL resolves unchanged',
  resolveSafeReturnUrl('https://app.example.com/apps/my-app?x=1') ===
    'https://app.example.com/apps/my-app?x=1'
);

console.log(failures === 0 ? '\n✅ All checks passed' : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
