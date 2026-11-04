// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Built-in groups the permission model depends on. They cannot be deleted and
 * are restored by migration V215 if they were removed from groups.json.
 */
export const PROTECTED_GROUP_IDS = Object.freeze(['admins', 'users', 'anonymous', 'authenticated']);
