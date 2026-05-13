#!/usr/bin/env node

/**
 * Unit tests for `server/utils/safeContentDisposition.js`.
 *
 * Run directly with `node server/tests/safeContentDisposition.test.js`.
 */

import { buildContentDisposition } from '../utils/safeContentDisposition.js';

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

console.log('🧪 buildContentDisposition — fallback\n');
check(
  'empty filename falls back to download',
  `attachment; filename="download"; filename*=UTF-8''download`,
  buildContentDisposition('')
);
check(
  'undefined falls back to download',
  `attachment; filename="download"; filename*=UTF-8''download`,
  buildContentDisposition(undefined)
);

console.log('\n🧪 buildContentDisposition — ASCII-safe filenames\n');
check(
  'plain ASCII filename passes through',
  `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
  buildContentDisposition('report.pdf')
);
check(
  'spaces preserved in ASCII portion, percent-encoded in UTF-8',
  `attachment; filename="my file.pdf"; filename*=UTF-8''my%20file.pdf`,
  buildContentDisposition('my file.pdf')
);

console.log('\n🧪 buildContentDisposition — injection attempts\n');
check(
  'double-quote sanitized to underscore in ASCII fallback',
  `attachment; filename="evil_.pdf"; filename*=UTF-8''evil%22.pdf`,
  buildContentDisposition('evil".pdf')
);
check(
  'backslash sanitized in ASCII fallback',
  `attachment; filename="a_b.pdf"; filename*=UTF-8''a%5Cb.pdf`,
  buildContentDisposition('a\\b.pdf')
);
check(
  'CRLF header-injection attempt neutered',
  `attachment; filename="a__b.pdf"; filename*=UTF-8''a%0D%0Ab.pdf`,
  buildContentDisposition('a\r\nb.pdf')
);
check(
  'second filename= injection attempt cannot escape the quoted value',
  // The attacker tries to inject `"; filename="evil.exe`. The `"` is
  // replaced with `_` in the ASCII fallback so the value stays inside
  // its own quoted region.
  `attachment; filename="ok.pdf_; filename=_evil.exe"; filename*=UTF-8''ok.pdf%22%3B%20filename%3D%22evil.exe`,
  buildContentDisposition('ok.pdf"; filename="evil.exe')
);

console.log('\n🧪 buildContentDisposition — non-ASCII\n');
check(
  'Unicode filename uses ASCII fallback + UTF-8 filename*',
  `attachment; filename="Berliner Stra_e.pdf"; filename*=UTF-8''Berliner%20Stra%C3%9Fe.pdf`,
  buildContentDisposition('Berliner Straße.pdf')
);
check(
  'emoji filename percent-encoded in UTF-8 portion',
  `attachment; filename="hello __.txt"; filename*=UTF-8''hello%20%F0%9F%91%8B.txt`,
  buildContentDisposition('hello 👋.txt')
);

console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);
