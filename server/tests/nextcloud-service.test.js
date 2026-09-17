#!/usr/bin/env node

/**
 * Manual test for NextcloudService pure helpers.
 *
 * Exercises:
 *   - `_buildCallbackUrl`: protocol/host extraction including proxy
 *     headers (matches the existing Office 365 test).
 *   - `_buildWebDavPath`: per-segment percent-encoding for filenames
 *     containing spaces, slashes, Unicode, and a literal `%`.
 *   - `_parsePropfindResponse`: handles the user-root entry, encoded
 *     filenames (including a literal `%` in the name), and a
 *     malformed `<d:getlastmodified>` value that would otherwise
 *     throw `RangeError: Invalid time value`.
 *
 * Run directly with `node server/tests/nextcloud-service.test.js`.
 */

import nextcloudService from '../services/integrations/NextcloudService.js';

function createMockRequest({
  protocol = 'http',
  host = 'localhost:3000',
  forwardedProto,
  forwardedHost
}) {
  const headers = {};
  if (forwardedProto) headers['x-forwarded-proto'] = forwardedProto;
  if (forwardedHost) headers['x-forwarded-host'] = forwardedHost;

  return {
    protocol,
    get(headerName) {
      const lowerName = headerName.toLowerCase();
      if (lowerName === 'x-forwarded-proto') return headers['x-forwarded-proto'];
      if (lowerName === 'x-forwarded-host') return headers['x-forwarded-host'];
      if (lowerName === 'host') return host;
      return undefined;
    }
  };
}

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

console.log('🧪 NextcloudService — callback URL\n');

check(
  'basic http',
  'http://localhost:3000/api/integrations/nextcloud/nextcloud-main/callback',
  nextcloudService._buildCallbackUrl(
    createMockRequest({ protocol: 'http', host: 'localhost:3000' }),
    'nextcloud-main'
  )
);

check(
  'https with custom host',
  'https://ihub.example.com/api/integrations/nextcloud/nc-prod/callback',
  nextcloudService._buildCallbackUrl(
    createMockRequest({ protocol: 'https', host: 'ihub.example.com' }),
    'nc-prod'
  )
);

check(
  'reverse proxy via X-Forwarded headers',
  'https://ihub.local.intrafind.io/api/integrations/nextcloud/nc-tenant1/callback',
  nextcloudService._buildCallbackUrl(
    createMockRequest({
      protocol: 'http',
      host: 'localhost:8080',
      forwardedProto: 'https',
      forwardedHost: 'ihub.local.intrafind.io'
    }),
    'nc-tenant1'
  )
);

try {
  nextcloudService._buildCallbackUrl(
    {
      protocol: 'https',
      get() {
        return undefined;
      }
    },
    'no-host'
  );
  console.log('❌ no-host case should have thrown');
  failures += 1;
} catch {
  console.log('✅ throws when host cannot be resolved');
}

console.log('\n🧪 NextcloudService — _buildWebDavPath\n');

check(
  'empty relative path returns user root with trailing slash',
  '/remote.php/dav/files/alice/',
  nextcloudService._buildWebDavPath('alice', '')
);

check(
  'single segment is percent-encoded',
  '/remote.php/dav/files/alice/Documents',
  nextcloudService._buildWebDavPath('alice', 'Documents')
);

check(
  'space in segment is encoded as %20',
  '/remote.php/dav/files/alice/My%20Folder',
  nextcloudService._buildWebDavPath('alice', 'My Folder')
);

check(
  'leading and trailing slashes are stripped',
  '/remote.php/dav/files/alice/a/b/c',
  nextcloudService._buildWebDavPath('alice', '///a//b/c///')
);

check(
  'literal percent in filename is encoded',
  '/remote.php/dav/files/alice/readme%25.txt',
  nextcloudService._buildWebDavPath('alice', 'readme%.txt')
);

check(
  'unicode segment is encoded',
  // 文字 is %E6%96%87%E5%AD%97
  '/remote.php/dav/files/alice/%E6%96%87%E5%AD%97',
  nextcloudService._buildWebDavPath('alice', '文字')
);

check(
  'username with special characters is encoded',
  '/remote.php/dav/files/alice%40example.com/file.txt',
  nextcloudService._buildWebDavPath('alice@example.com', 'file.txt')
);

console.log('\n🧪 NextcloudService — _parsePropfindResponse\n');

const xml = `<?xml version='1.0' encoding='utf-8'?>
<d:multistatus xmlns:d='DAV:' xmlns:oc='http://owncloud.org/ns'>
  <d:response>
    <d:href>/remote.php/dav/files/alice/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/></d:resourcetype>
      <oc:fileid>0</oc:fileid>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Docs/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/></d:resourcetype>
      <oc:fileid>1</oc:fileid>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Docs/My%20Folder/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/></d:resourcetype>
      <oc:fileid>2</oc:fileid>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Docs/readme%25.txt</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>42</d:getcontentlength>
      <d:getcontenttype>text/plain</d:getcontenttype>
      <d:getlastmodified>Mon, 04 May 2026 09:00:00 GMT</d:getlastmodified>
      <oc:fileid>3</oc:fileid>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Docs/bad-date.txt</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>7</d:getcontentlength>
      <d:getcontenttype>text/plain</d:getcontenttype>
      <d:getlastmodified>not a date</d:getlastmodified>
      <oc:fileid>4</oc:fileid>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`;

const items = nextcloudService._parsePropfindResponse(xml, '/remote.php/dav/files/alice/');

check(
  'user-root entry is skipped (no empty path entries)',
  false,
  items.some(i => i.path === '')
);
check('non-recursive listing returns 4 entries', 4, items.length);

const docs = items.find(i => i.id === '1');
check('top-level folder path is "Docs"', 'Docs', docs?.path);
check('top-level folder name is "Docs"', 'Docs', docs?.name);
check('top-level folder is a collection', true, docs?.isFolder);

const subFolder = items.find(i => i.id === '2');
check('nested folder path joins parent + child', 'Docs/My Folder', subFolder?.path);
check('nested folder name decodes %20 to space', 'My Folder', subFolder?.name);

const readme = items.find(i => i.id === '3');
check('file with literal % in name decodes once (not twice)', 'readme%.txt', readme?.name);
check('file path is "Docs/readme%.txt"', 'Docs/readme%.txt', readme?.path);
check('file is not a folder', false, readme?.isFolder);
check('file size is parsed', 42, readme?.size);
check('file mime type is parsed', 'text/plain', readme?.mimeType);
check(
  'parseable last-modified is ISO-encoded',
  '2026-05-04T09:00:00.000Z',
  readme?.lastModifiedDateTime
);

const badDate = items.find(i => i.id === '4');
check(
  'unparseable last-modified falls back to null (no RangeError)',
  null,
  badDate?.lastModifiedDateTime
);
check('listing did not abort because of one bad entry', true, !!badDate);

console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);
