// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The message keys the "New app" page picks by a value: the screen, the way
 * the author started, a field. They are full, literal keys in exported maps,
 * so the i18n test can check every one of them in both languages
 * (`tests/unit/client/app-builder-i18n.test.jsx`).
 *
 * Pure: no React, no browser API.
 *
 * @module features/admin/components/app-create/createKeys
 */

/**
 * The ways to start an app. Each is also the `origin` the create request
 * names (`APP_CREATE_ORIGINS` in `shared/appGenerator.js`).
 *
 * - `blank`: "Start empty";
 * - `generated`: the AI prepared a draft from a description;
 * - `template`: one of the shipped templates;
 * - `copy`: a copy of an existing app ("Duplicate", "Copy an existing app");
 * - `link`: a link to a website, or a website shown inside iHub.
 */
export const START_KINDS = Object.freeze(['blank', 'generated', 'template', 'copy', 'link']);

/** The two screens of the page, in order. */
export const SCREENS = Object.freeze(['start', 'essentials']);

/** The name of each screen in the step line ("Step 1 of 2: Start"). */
export const STEP_KEYS = Object.freeze({
  start: 'admin.apps.create.steps.start',
  essentials: 'admin.apps.create.steps.essentials'
});

/** The heading of the Essentials screen, by start. */
export const HEADING_KEYS = Object.freeze({
  blank: 'admin.apps.create.essentials.heading.blank',
  generated: 'admin.apps.create.essentials.heading.draft',
  template: 'admin.apps.create.essentials.heading.template',
  copy: 'admin.apps.create.essentials.heading.copy',
  link: 'admin.apps.create.essentials.heading.link'
});

/**
 * The notice at the top of the Essentials screen, by start. It takes the name
 * of the template or of the copied app as `name`. An empty start and a link
 * app have none; the notice of an AI draft is a component of its own
 * (`DraftExtras`).
 */
export const NOTE_KEYS = Object.freeze({
  blank: null,
  generated: null,
  template: 'admin.apps.create.template.note',
  copy: 'admin.apps.create.copy.note',
  link: null
});

/** The label of each field of the Essentials screen, as the author reads it. */
export const FIELD_LABEL_KEYS = Object.freeze({
  name: 'admin.apps.create.essentials.name',
  description: 'admin.apps.create.essentials.description',
  system: 'admin.apps.create.essentials.instructions',
  url: 'admin.apps.create.link.url',
  mode: 'admin.apps.create.link.mode',
  icon: 'admin.apps.create.essentials.icon',
  color: 'admin.apps.create.essentials.color',
  id: 'admin.apps.create.essentials.id',
  category: 'admin.apps.create.essentials.category'
});

/** The fields that sit under "More details". */
export const DETAIL_FIELDS = Object.freeze(['id', 'category']);

/** The fields of the Essentials screen, in the order they appear. */
export const FIELD_ORDER = Object.freeze([
  'name',
  'description',
  'system',
  'url',
  'mode',
  'icon',
  'color',
  'id',
  'category'
]);

/**
 * The DOM id of a field's control. The error summary links to it, and the
 * page moves the focus there.
 *
 * @param {string} field - A key of {@link FIELD_LABEL_KEYS}.
 * @returns {string}
 */
export function fieldDomId(field) {
  return `app-create-${field}`;
}
