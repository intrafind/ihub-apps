// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `guardedResourceOf` maps an admin API URL to the resource whose revision it
 * guards, ignoring the query, the fragment and trailing slashes, in linear time
 * (Sonar S8786: `/\/+$/` was quadratic on a long run of slashes).
 */

import { guardedResourceOf } from '../../../client/src/api/adminConfigRevision.js';

describe('guardedResourceOf', () => {
  it.each([
    ['/admin/configs/platform', 'platform'],
    ['admin/configs/platform', 'platform'],
    ['/admin/configs/platform/', 'platform'],
    ['/admin/configs/platform///?x=1', 'platform'],
    ['/admin/ui/config#top', 'ui'],
    ['/admin/ui/config//#/', 'ui'],
    ['/admin/ui/configs', null],
    ['/', null],
    ['', null],
    [undefined, null]
  ])('%j is %j', (url, expected) => {
    expect(guardedResourceOf(url)).toBe(expected);
  });

  it('a 50k run of slashes that does not end the URL finishes fast', () => {
    const url = `${'/'.repeat(50000)}x`;
    const start = performance.now();
    expect(guardedResourceOf(url)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
  });
});
