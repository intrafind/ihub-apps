// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The documentation section each admin page links to with its "?" help link (`DocsLink`).
 *
 * `page` is a path relative to `docs/`, `section` the heading anchor mdBook gives the heading
 * (see `shared/docsAnchors.js`). Keep the anchors in step with the headings: the test
 * `tests/unit/client/docs-help-link.test.jsx` fails when a heading named here is renamed.
 *
 * @type {Readonly<Record<string, { page: string, section?: string }>>}
 */
export const DOCS_HELP_TOPICS = Object.freeze({
  models: { page: 'models.md', section: 'set-up-models-in-the-admin-ui' },
  providers: { page: 'models.md', section: 'connect-a-provider' },
  apps: { page: 'app-quickstart.md' },
  prompts: { page: 'prompts.md', section: 'admin' },
  access: { page: 'access-control.md' }
});

/**
 * The admin route (without base path) of a help topic's documentation section, for example
 * `/admin/docs/models.md#connect-a-provider`.
 *
 * @param {string} topic a key of {@link DOCS_HELP_TOPICS}
 * @returns {string|null} the route, or `null` for an unknown topic
 */
export function docsHelpPath(topic) {
  const entry = Object.prototype.hasOwnProperty.call(DOCS_HELP_TOPICS, topic)
    ? DOCS_HELP_TOPICS[topic]
    : null;
  if (!entry) return null;
  // The same route `docsLinkTarget` builds for a link inside the documentation. This module does
  // not import it: docsLinks pulls in runtimeBasePath, which page tests cannot load.
  const route = `/admin/docs/${entry.page.split('/').map(encodeURIComponent).join('/')}`;
  return entry.section ? `${route}#${entry.section}` : route;
}
