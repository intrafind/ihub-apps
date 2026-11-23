// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the "New app" page of the admin area hands to the create screens
 * (`components/app-create/`): the API calls, the starts it offers, the fields
 * under "More details" and the texts that differ between the admin page and
 * the page for personal apps
 * (`features/apps/builder/userAppSource.js`).
 *
 * The screens treat a missing `source` exactly like this one, so the admin
 * page behaves as it did before the screens knew about sources. This file
 * lives outside `app-create/` because it is the one place that names
 * `adminApi`: no file in that directory imports an API module.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, section 11.3.
 *
 * @module features/admin/utils/adminAppSource
 */

import { fetchModels, fetchUIConfig } from '../../../api';
import {
  createAdminApp,
  fetchAdminApp,
  fetchAdminApps,
  fetchAdminAppTemplates,
  fetchAppStartTemplates,
  generateAppDraft
} from '../../../api/adminApi';
import { UI_CREATES_PUBLISHED } from '../../../../../shared/appDefaults.js';

/**
 * @typedef {object} AppCreateSource
 * @property {'admin'|'personal'} kind
 * @property {() => Promise<object[]>} fetchTemplates - The templates of the Start screen.
 * @property {(request: { description: string, language?: string, signal: AbortSignal }) => Promise<object>} generateDraft
 * @property {() => Promise<object[]>} fetchModels - The models the author may use.
 * @property {(payload: object, options: { origin: string }) => Promise<object>} createApp
 * @property {Function} [refineDraft] - The call behind "Change the draft". The
 *   screens show that control only when the source has this member.
 * @property {{ describe: boolean, templates: boolean, empty: boolean, copy: boolean, link: boolean, marketplace: boolean }} starts
 * @property {boolean} showAppId - Whether "More details" has the app ID.
 * @property {boolean} showCategory - Whether "More details" has the category.
 * @property {{ webSearch: boolean, integrations: boolean }} suggestions - What a draft may offer.
 * @property {{ stateLine: string, submit: string, limits: string|null }} copy - Message keys.
 */

/** @type {AppCreateSource} */
export const adminAppSource = Object.freeze({
  kind: 'admin',
  fetchTemplates: fetchAppStartTemplates,
  generateDraft: generateAppDraft,
  // A fresh list: a model that was connected a minute ago must be found.
  fetchModels: () => fetchModels({ skipCache: true }),
  createApp: createAdminApp,
  // What only the admin page needs: the apps that exist (taken IDs and names),
  // the app to copy, the apps that can be copied, and the categories.
  fetchApps: fetchAdminApps,
  fetchApp: fetchAdminApp,
  fetchExistingApps: fetchAdminAppTemplates,
  fetchUiConfig: () => fetchUIConfig(),
  starts: Object.freeze({
    describe: true,
    templates: true,
    empty: true,
    copy: true,
    link: true,
    marketplace: true
  }),
  showAppId: true,
  showCategory: true,
  suggestions: Object.freeze({ webSearch: true, integrations: true }),
  copy: Object.freeze({
    stateLine: UI_CREATES_PUBLISHED
      ? 'admin.apps.create.essentials.audienceLive'
      : 'admin.apps.create.essentials.audience',
    submit: 'admin.apps.create.submit',
    limits: null,
    instructionsHelp: 'admin.apps.create.essentials.instructionsHelp'
  })
});

export default adminAppSource;
