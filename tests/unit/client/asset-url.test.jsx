// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { isCompleteAssetUrl, resolveAssetUrl } from '../../../client/src/utils/assetUrl';

/**
 * The header logo (sidebar, header, start page) and other asset URLs on a
 * deployment under `/ihub`. A logo URL that already held the base path was
 * prefixed again (`/ihub/ihub/…`, a 404 behind a proxy that forwards the
 * prefix), and a `data:` image became `/ihub/data:…`.
 */

describe('resolveAssetUrl under /ihub', () => {
  test.each([
    ['/uploads/assets/logo.png', '/ihub/uploads/assets/logo.png'],
    ['uploads/assets/logo.png', '/ihub/uploads/assets/logo.png'],
    ['/icons/apps-svg-logo.svg', '/ihub/icons/apps-svg-logo.svg'],
    ['logo.png', '/ihub/logo.png'],
    // Already under the base path: as an admin copies it from the address bar.
    ['/ihub/uploads/assets/logo.png', '/ihub/uploads/assets/logo.png'],
    ['/ihub', '/ihub'],
    // Only the whole first segment counts: `/ihubs` is not under `/ihub`.
    ['/ihubs/logo.png', '/ihub/ihubs/logo.png']
  ])('%s → %s', (asset, expected) => {
    expect(resolveAssetUrl(asset, '/ihub')).toBe(expected);
  });

  test.each([
    'https://cdn.example.com/logo.png',
    'http://intranet/logo.png',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'DATA:image/png;base64,iVBORw0KGgo=',
    'blob:https://ihub.example.com/1234',
    '//cdn.example.com/logo.png'
  ])('%s is used as it is', asset => {
    expect(isCompleteAssetUrl(asset)).toBe(true);
    expect(resolveAssetUrl(asset, '/ihub')).toBe(asset);
  });

  test('other schemes are not complete URLs and stay under the base path', () => {
    expect(isCompleteAssetUrl('javascript:alert(1)')).toBe(false);
    expect(isCompleteAssetUrl('data:text/html,<b>x</b>')).toBe(false);
  });
});

describe('resolveAssetUrl at the root', () => {
  test.each([
    ['/uploads/assets/logo.png', '/uploads/assets/logo.png'],
    ['uploads/assets/logo.png', '/uploads/assets/logo.png'],
    ['/ihub/logo.png', '/ihub/logo.png'],
    ['data:image/png;base64,iVBORw0KGgo=', 'data:image/png;base64,iVBORw0KGgo=']
  ])('%s → %s', (asset, expected) => {
    expect(resolveAssetUrl(asset, '')).toBe(expected);
  });
});
