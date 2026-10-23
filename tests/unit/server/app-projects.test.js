// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, expect, it } from '@jest/globals';
import { appAllowsUserProjects, appUsesProjects } from '../../../shared/appProjects.js';

/**
 * The per-app project switches (`features.projects`, `features.userProjects`),
 * shared by the server and the browser: both on unless set to `false`, and
 * personal projects only while the app uses projects at all.
 */
describe('app project switches', () => {
  it('are on when the app says nothing', () => {
    for (const app of [undefined, null, {}, { features: {} }]) {
      expect(appUsesProjects(app)).toBe(true);
      expect(appAllowsUserProjects(app)).toBe(true);
    }
  });

  it('turn off only for an explicit false', () => {
    expect(appUsesProjects({ features: { projects: false } })).toBe(false);
    expect(appUsesProjects({ features: { projects: 'false' } })).toBe(true);
    expect(appAllowsUserProjects({ features: { userProjects: false } })).toBe(false);
  });

  it('take no personal projects while projects are off', () => {
    const app = { features: { projects: false, userProjects: true } };
    expect(appAllowsUserProjects(app)).toBe(false);
  });
});
