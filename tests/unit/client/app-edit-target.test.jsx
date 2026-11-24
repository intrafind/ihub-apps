// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The "Edit app" button of a chat: a personal app is edited in the personal
 * editor by whoever the server says may edit it; every other app in the admin
 * editor by admins. The admin editor does not know personal apps.
 */
import { describe, expect, test } from 'vitest';
import { appEditPath } from '../../../client/src/features/apps/utils/appEditTarget';

const admin = { isAdmin: true };
const person = { isAdmin: false };

describe('appEditPath', () => {
  test('a personal app goes to the personal editor, also for an admin', () => {
    const app = { ownership: 'user', permissions: { canEdit: true } };
    expect(appEditPath(app, admin, 'uap_1')).toBe('/apps/uap_1/edit');
    expect(appEditPath(app, person, 'uap_1')).toBe('/apps/uap_1/edit');
  });

  test('a personal app the viewer may not edit shows no button, even for an admin', () => {
    const app = { ownership: 'user', permissions: { canEdit: false } };
    expect(appEditPath(app, admin, 'uap_1')).toBeNull();
    expect(appEditPath({ ownership: 'user' }, person, 'uap_1')).toBeNull();
  });

  test('a company app goes to the admin editor for admins only', () => {
    expect(appEditPath({ id: 'chat' }, admin, 'chat')).toBe('/admin/apps/chat');
    expect(appEditPath({ id: 'chat' }, person, 'chat')).toBeNull();
    expect(appEditPath({ id: 'chat' }, null, 'chat')).toBeNull();
  });

  test('nothing without an app ID', () => {
    expect(appEditPath({}, admin, undefined)).toBeNull();
  });
});
