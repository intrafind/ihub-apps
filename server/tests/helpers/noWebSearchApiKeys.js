// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Keeps the web search API keys of the machine running the tests out of a test.
 *
 * `server/config.js` copies every `*_API_KEY` environment variable into its
 * frozen export once, when it is first imported, and `resolveEngineApiKey`
 * prefers that copy to `process.env`. A test that deletes or sets
 * `process.env.STAAN_API_KEY` in `beforeEach` therefore changes nothing when
 * the shell (or the `.env` file, which `config.js` loads) already holds a key:
 * "no key" tests find one, and "falls back to the environment variable" tests
 * read the machine's key instead of their own.
 *
 * Import this module FIRST in the test file, so that it runs before anything
 * that imports `config.js`:
 *
 * ```js
 * import '../helpers/noWebSearchApiKeys.js';
 * ```
 *
 * The variables are set to an empty string rather than deleted: `dotenv` does
 * not override a variable that exists, so an empty one also keeps a key in
 * `.env` out. An empty value is falsy, so the lookup falls through to
 * `process.env`, which the test then controls.
 */
for (const name of ['BRAVE_SEARCH_API_KEY', 'STAAN_API_KEY']) {
  process.env[name] = '';
}
