#!/usr/bin/env node

/**
 * Unit tests for `server/utils/oauthReturnUrl.js`.
 *
 * Run directly with `node server/tests/oauthReturnUrl.test.js`.
 */

import { isValidReturnUrl } from '../utils/oauthReturnUrl.js';

let failures = 0;
function check(label, expected, actual) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    console.log(`   expected: ${expected}`);
    console.log(`   actual:   ${actual}`);
  }
}

const req = { hostname: 'ihub.example.com' };

console.log('🧪 isValidReturnUrl — falsy / empty\n');
check('null is rejected', false, isValidReturnUrl(null, req));
check('undefined is rejected', false, isValidReturnUrl(undefined, req));
check('empty string is rejected', false, isValidReturnUrl('', req));

console.log('\n🧪 isValidReturnUrl — relative paths\n');
check('plain relative path accepted', true, isValidReturnUrl('/settings/integrations', req));
check('relative path with query accepted', true, isValidReturnUrl('/page?x=1&y=2', req));
check(
  'protocol-relative // is rejected (would redirect off-site)',
  false,
  isValidReturnUrl('//evil.com/path', req)
);

console.log('\n🧪 isValidReturnUrl — absolute URLs, same host\n');
check('https same host accepted', true, isValidReturnUrl('https://ihub.example.com/x', req));
check('http same host accepted', true, isValidReturnUrl('http://ihub.example.com/x', req));
check(
  'https different host rejected',
  false,
  isValidReturnUrl('https://attacker.example.com/x', req)
);

console.log('\n🧪 isValidReturnUrl — non-http(s) schemes (the real bug)\n');
check(
  'javascript: with host-shaped authority rejected',
  false,
  isValidReturnUrl('javascript://ihub.example.com/%0Aalert(1)', req)
);
check('data: rejected', false, isValidReturnUrl('data:text/html,<script>alert(1)</script>', req));
check('file: rejected', false, isValidReturnUrl('file:///etc/passwd', req));
check('gopher: rejected', false, isValidReturnUrl('gopher://ihub.example.com/x', req));
check('ftp: rejected (defense in depth)', false, isValidReturnUrl('ftp://ihub.example.com/x', req));

console.log('\n🧪 isValidReturnUrl — malformed input\n');
check('garbage string rejected', false, isValidReturnUrl('not a url', req));
check('space-prefixed rejected', false, isValidReturnUrl(' /foo', req));
check('repeated query parameter (array) rejected', false, isValidReturnUrl(['/a', '/b'], req));

// Browsers read `\` as `/` and drop tabs/newlines in a Location header, so each of these
// ends up as the protocol-relative `//evil.example.com` (a link to another site).
console.log('\n🧪 isValidReturnUrl — backslash and control-character bypasses\n');
check('/\\host rejected', false, isValidReturnUrl('/\\evil.example.com', req));
check('/\\/host rejected', false, isValidReturnUrl('/\\/evil.example.com', req));
check('/<TAB>/host rejected', false, isValidReturnUrl('/\t/evil.example.com', req));
check('/<CR><LF>/host rejected', false, isValidReturnUrl('/\r\n/evil.example.com', req));
check('NUL byte rejected', false, isValidReturnUrl('/ok\0/x', req));
check('DEL rejected', false, isValidReturnUrl('/ok\x7f', req));
check(
  'backslash in an absolute same-host URL rejected',
  false,
  isValidReturnUrl('https://ihub.example.com\\@evil.example.com/', req)
);
check(
  'percent-encoded backslash and spaces are harmless and accepted',
  true,
  isValidReturnUrl('/apps/my%20chat%5Cx?q=a%20b#frag', req)
);

console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);
