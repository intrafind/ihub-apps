// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `redactUrlSecrets` has a single implementation in the dependency-free
 * `secretNames.js` (it masks every basic-auth userinfo and the query parameters
 * listed in `SECRET_QUERY_PARAMS` there). This module re-exports it so existing
 * imports keep resolving.
 *
 * @module utils/urlSecrets
 */
export { redactUrlSecrets } from './secretNames.js';
