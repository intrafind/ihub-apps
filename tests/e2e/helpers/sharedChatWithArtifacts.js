// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A shared chat with generated files, served by request interception so a
 * test needs no model, no stored chat and no share: the share routes the
 * shared-chat page calls are answered here, and the ZIP requests recorded.
 */

export const SHARE_ID = 'e2e-artifacts-share';

const ARTIFACTS = [
  {
    id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    kind: 'code',
    mimeType: 'text/javascript',
    name: 'src/index.js',
    bytes: 32,
    createdAt: '2026-10-30T10:00:00.000Z'
  },
  {
    id: 'b1b2c3d4e5f60718293a4b5c6d7e8f90',
    kind: 'code',
    mimeType: 'application/json',
    name: 'package.json',
    bytes: 27,
    createdAt: '2026-10-30T10:00:01.000Z'
  },
  {
    id: 'c1b2c3d4e5f60718293a4b5c6d7e8f90',
    kind: 'code',
    mimeType: 'text/markdown',
    name: 'README.md',
    bytes: 24,
    createdAt: '2026-10-30T10:00:02.000Z'
  }
];

const CONTENT = {
  [ARTIFACTS[0].id]: ['text/plain; charset=utf-8', 'console.log("hello, world");\n'],
  [ARTIFACTS[1].id]: ['application/json; charset=utf-8', '{"name":"demo","version":"1.0.0"}'],
  [ARTIFACTS[2].id]: ['text/markdown; charset=utf-8', '# Demo\n\nRun `node src/index.js`.\n']
};

/**
 * Answer the share routes of {@link SHARE_ID} for `page`.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ zipRequests: Array<Object> }>} The bodies of the ZIP requests made.
 */
export async function mockSharedChatWithArtifacts(page) {
  const zipRequests = [];
  await page.route(new RegExp(`/api/shares/${SHARE_ID}(/|$|\\?)`), async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const rest = pathname.slice(pathname.indexOf(SHARE_ID) + SHARE_ID.length);

    if (rest === '' && request.method() === 'GET') {
      return route.fulfill({
        json: {
          share: {
            id: SHARE_ID,
            mode: 'authenticated',
            title: 'A demo project',
            sharedBy: 'Ada',
            createdAt: '2026-10-30T10:05:00.000Z',
            app: { name: { en: 'Chat', de: 'Chat' }, color: '#4f46e5', icon: 'chat-bubble' }
          },
          messages: [
            { id: 'm1', role: 'user', content: 'Create a small Node project.' },
            {
              id: 'm2',
              role: 'assistant',
              content: 'Here is the project: `src/index.js`, `package.json` and `README.md`.',
              artifacts: ARTIFACTS
            }
          ],
          version: 1
        }
      });
    }
    if (rest === '/artifacts' && request.method() === 'GET') {
      return route.fulfill({ json: { items: [...ARTIFACTS].reverse() } });
    }
    if (rest === '/artifacts/zip' && request.method() === 'POST') {
      zipRequests.push(request.postDataJSON() || {});
      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="shared-chat-artifacts.zip"'
        },
        body: Buffer.from('PK\u0005\u0006' + '\u0000'.repeat(18), 'binary')
      });
    }
    const match = /^\/artifacts\/([a-f0-9]{32})$/.exec(rest);
    if (match && CONTENT[match[1]]) {
      const [contentType, body] = CONTENT[match[1]];
      return route.fulfill({ status: 200, headers: { 'Content-Type': contentType }, body });
    }
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  return { zipRequests };
}
