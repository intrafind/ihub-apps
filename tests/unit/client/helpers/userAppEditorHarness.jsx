// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the tests of the personal app editor share (`user-app-edit`,
 * `user-app-share`, `transfer-owner-dialog`): the texts, answers of the
 * server as section 9.1 of the design describes them, and failures as the
 * API module rejects with them.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md.
 */
const i18next = require('i18next');
const en = require('../../../../shared/i18n/en.json');
const de = require('../../../../shared/i18n/de.json');

/** A new i18next instance with the real texts; call `initTexts` before the first test. */
function createTexts() {
  const instance = i18next.createInstance();
  const init = async () => {
    await instance.init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: en }, de: { translation: de } },
      // A key without a text comes back as the key (or as the fallback an
      // existing component carries); `untranslated` finds the keys.
      interpolation: { escapeValue: false }
    });
  };
  const translation = { t: instance.t.bind(instance), i18n: instance };
  return { instance, init, translation };
}

/**
 * The i18n keys that show as text in an element: a key of this slice's
 * groups that has no text in the locale files .
 *
 * @param {HTMLElement} element
 * @returns {string[]}
 */
function untranslated(element) {
  return element.textContent.match(/\b(?:userApps|apiErrors)\.[A-Za-z_.]+/g) || [];
}

const APP_ID = 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8';

const OWNER_PERMISSIONS = {
  canView: true,
  canUse: true,
  canEdit: true,
  canShare: true,
  canDelete: true,
  canOffer: true,
  canAcceptOffer: false,
  canPublish: false,
  isOwner: true,
  role: 'owner',
  readOnly: false,
  suspended: null
};

/**
 * The full body of `GET /api/apps/{appId}` for the owner; `changes` replace
 * top-level keys, and `permissions` are merged.
 */
function userApp(changes = {}) {
  const { permissions, ...rest } = changes;
  return {
    id: APP_ID,
    type: 'chat',
    enabled: true,
    name: { en: 'Job ad writer' },
    description: { en: 'Drafts a job ad from your notes' },
    system: { en: 'You write job ads from notes.' },
    icon: 'document-text',
    color: '#4F46E5',
    variables: [],
    starterPrompts: [],
    upload: { enabled: true },
    websearch: { enabled: false },
    ownership: 'user',
    language: 'en',
    owner: { id: 'anna', name: 'Anna Schmidt', active: true },
    permissions: { ...OWNER_PERMISSIONS, ...permissions },
    sharedWith: { users: 0, groups: 0, everyone: false },
    capabilities: [
      { id: 'model', requested: false, granted: false, reason: 'notRequested' },
      { id: 'upload', requested: true, granted: true },
      { id: 'webSearch', requested: false, granted: false, reason: 'notRequested' },
      { id: 'skills', requested: false, granted: false, reason: 'notRequested' }
    ],
    approval: { mode: 'writes', chatGrants: true },
    state: 'active',
    disabled: null,
    revision: 7,
    updatedAt: '2026-11-20T10:00:00Z',
    updatedBy: { id: 'anna', name: 'Anna Schmidt' },
    members: [],
    pendingOwner: null,
    ...rest
  };
}

const EDITOR_PERMISSIONS = {
  canDelete: false,
  canOffer: false,
  isOwner: false,
  role: 'editor'
};

/** `capabilities` of `GET /api/apps/_config`. */
const ALLOWED = {
  modelChoice: false,
  upload: true,
  webSearch: true,
  skills: false,
  integrations: [
    {
      id: 'jira-main',
      label: 'Jira',
      actions: [
        { name: 'searchIssues', description: 'Search issues' },
        { name: 'getIssue', description: 'Read an issue' }
      ]
    }
  ]
};

const CONFIG = {
  enabled: true,
  canCreate: true,
  canShare: true,
  canPublish: false,
  maxApps: 20,
  used: 3,
  generator: true,
  generatorEnabled: true,
  capabilities: ALLOWED
};

/** A failure as the API module rejects with it (`enhanceApiError`). */
function apiFailure(status, data) {
  const original = new Error(`Request failed with status code ${status}`);
  original.response = { status, data };
  const error = new Error(data?.detail || 'Request failed');
  error.status = status;
  error.code = data?.code;
  error.originalError = original;
  return error;
}

module.exports = {
  createTexts,
  untranslated,
  APP_ID,
  OWNER_PERMISSIONS,
  EDITOR_PERMISSIONS,
  ALLOWED,
  CONFIG,
  userApp,
  apiFailure,
  en,
  de
};
