// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the "New app" page for personal apps (`/apps/new`) hands to the create
 * screens of `features/admin/components/app-create/`: the routes of the user
 * API, the starts it offers and the texts that differ from the admin page
 * (`features/admin/utils/adminAppSource.js`).
 *
 * A personal app has no ID to choose and no category, cannot be a link app,
 * and does not come from the Marketplace. It can be a copy of an app the
 * person has access to: a company app they may use, or a personal app they
 * own or that is shared with them (`userAppCopy.js` says which apps qualify
 * and what the copy takes). This source has no `refineDraft`, so the screens
 * show no "Change the draft" control, and a person without admin rights never
 * calls an admin route: the copy lists and loads apps through the user API.
 *
 * The calls reject with the request's own error (`error.response` holds the
 * status and the problem body), because that is what the create screens read.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, section 11.3.
 *
 * @module features/apps/builder/userAppSource
 */

import {
  createUserApp,
  fetchApps,
  fetchModels,
  fetchUserApp,
  fetchUserApps,
  fetchUserAppsConfig,
  fetchUserAppTemplates,
  generateUserApp
} from '../../../api';
import { pickUserAppContent, USER_APP_ORIGINS } from '../../../../../shared/userAppContent.js';
import {
  copyableApps,
  copySourceOf,
  isCopyableAsUserApp,
  notCopyableError
} from './userAppCopy.js';

/**
 * The answers to a create request that are about the installation or the
 * person, not about a field: the create screens read 409 as "this app ID is
 * taken" and 403 as "you may not create apps", which is wrong for these.
 */
const STATUS_TOLD_BY_CODE = new Set([
  'QUOTA_USER_APPS',
  'USER_APP_CAPABILITY_DENIED',
  'USER_APP_ACCESS_CHANGED',
  'USER_APPS_DISABLED'
]);

/** The status the create screens answer with the server's own sentence. */
const UNPROCESSABLE = 422;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The request's own error behind the error of the shared API helper. */
const requestError = error => error?.originalError ?? error;

/** Runs a call of the API module and rejects with the request's own error. */
async function plain(call) {
  try {
    return await call();
  } catch (error) {
    throw requestError(error);
  }
}

/**
 * The content without what the installation does not allow in an app of this
 * person (`capabilities` of `GET /api/apps/_config`): a switch that is off
 * there is off here, a bound system keeps only the actions on the list, and
 * the model is left out when the author may not choose one.
 *
 * A template and the defaults of an empty app can carry more than a personal
 * app may ask for. The server would refuse the whole app, on a page that has
 * no control to remove the capability; so the page leaves it out. Without
 * the list (`allowed` absent) nothing is removed and the server decides.
 *
 * @param {object} content - The result of `pickUserAppContent`.
 * @param {object|null|undefined} allowed - `{ modelChoice, upload, webSearch, skills, integrations }`.
 * @returns {object} A new object.
 */
export function limitToAllowed(content, allowed) {
  if (!isPlainObject(allowed)) return content;
  const asked = isPlainObject(content.capabilities) ? content.capabilities : {};
  const actionsOf = new Map(
    (Array.isArray(allowed.integrations) ? allowed.integrations : [])
      .filter(isPlainObject)
      .map(system => [
        system.id,
        new Set(
          (Array.isArray(system.actions) ? system.actions : []).map(action =>
            typeof action === 'string' ? action : action?.name
          )
        )
      ])
  );
  const integrations = (Array.isArray(asked.integrations) ? asked.integrations : [])
    .map(binding => ({
      id: binding.id,
      actions: binding.actions.filter(action => actionsOf.get(binding.id)?.has(action))
    }))
    .filter(binding => binding.actions.length > 0);

  const limited = {
    ...content,
    capabilities: {
      upload: asked.upload === true && allowed.upload === true,
      webSearch: asked.webSearch === true && allowed.webSearch === true,
      skills: asked.skills === true && allowed.skills === true,
      integrations
    }
  };
  if (allowed.modelChoice !== true) delete limited.preferredModel;
  return limited;
}

/**
 * The body of `POST /api/apps` for a draft of the create screens: the language
 * the author wrote in, how the app was started, and the content keys a
 * personal app may have. Everything else of the draft (the ID, the category,
 * the publishing state, settings only a company app has) is left out.
 *
 * @param {object} draft - The draft as the create screens send it.
 * @param {object} options
 * @param {string} options.language - The content language.
 * @param {string} [options.origin] - How the app was started; `blank` when it
 *   is not one of `USER_APP_ORIGINS`.
 * @param {object|null} [options.allowed] - See {@link limitToAllowed}.
 * @returns {object}
 *
 * @example
 * buildUserAppBody({ id: 'x', category: 'utility', name: { de: 'Helfer' } }, { language: 'de', origin: 'template' });
 * // → { language: 'de', origin: 'template', name: { de: 'Helfer' },
 * //     capabilities: { upload: false, webSearch: false, skills: false, integrations: [] } }
 */
export function buildUserAppBody(draft, { language, origin, allowed } = {}) {
  return {
    language,
    origin: USER_APP_ORIGINS.includes(origin) ? origin : 'blank',
    ...limitToAllowed(pickUserAppContent(draft), allowed)
  };
}

/**
 * A failed create request as the create screens read it. An answer about the
 * limit, a capability or the feature keeps its problem body and gets a status
 * the screens show with the server's own sentence (`apiErrors.<code>`).
 *
 * @param {unknown} error - What the request rejected with.
 * @returns {unknown} The error to throw.
 */
export function asCreateFailure(error) {
  const plainError = requestError(error);
  const response = plainError?.response;
  if (!response) return plainError;
  const told = response.status === 409 || STATUS_TOLD_BY_CODE.has(response.data?.code);
  if (!told) return plainError;
  const failure = new Error(plainError.message);
  failure.response = { ...response, status: UNPROCESSABLE };
  failure.cause = plainError;
  return failure;
}

/** What personal apps offer the caller (`GET /api/apps/_config`, the `userApps` block). */
const fetchConfig = ({ language } = {}) => plain(() => fetchUserAppsConfig({ language }));

/** The templates a personal app can start from (`GET /api/apps/_templates`). */
const fetchTemplates = () => plain(() => fetchUserAppTemplates());

/**
 * Have a model prepare a draft (`POST /api/apps/_generate`). Request and
 * response are those of the admin route; nothing is stored. Aborting the
 * signal cancels the request, and the server then stops the model call.
 *
 * @param {{ description: string, language?: string, signal?: AbortSignal }} request
 * @returns {Promise<{ app: object, suggestions: object, warnings: object[], model: object }>}
 */
const generateDraft = ({ description, language, signal }) =>
  plain(() => generateUserApp({ description, language, signal }));

/**
 * Create the app (`POST /api/apps`).
 *
 * @param {object} draft - The draft as the create screens send it.
 * @param {{ origin?: string, language: string, allowed?: object|null }} options
 * @returns {Promise<object>} The created app, with the ID the server gave it.
 */
const createApp = async (draft, options = {}) => {
  try {
    return await createUserApp(buildUserAppBody(draft, options));
  } catch (error) {
    throw asCreateFailure(error);
  }
};

/**
 * The apps the person can copy into an app of their own: the company apps of
 * `GET /api/apps` and the personal apps of `GET /api/apps?scope=personal`,
 * without those a personal app cannot become (`copyableApps`). The personal
 * apps are a second request; when it fails, the company apps are still
 * offered.
 *
 * Each item is already what the copy starts from (`copySourceOf`): the
 * create screens hand a picked item to the copy as it is.
 *
 * @returns {Promise<object[]>}
 */
const fetchExistingApps = async () => {
  const [companyApps, personalApps] = await Promise.all([
    plain(() => fetchApps()),
    plain(() => fetchUserApps({ scope: 'personal' })).catch(() => [])
  ]);
  return copyableApps(companyApps, personalApps).map(copySourceOf);
};

/**
 * The app a copy starts from (`GET /api/apps/{appId}`, which answers company
 * and personal apps alike, with the ID encoded for the URL). It resolves with
 * what a personal app may hold (`copySourceOf`) and rejects with
 * `code: 'APP_NOT_COPYABLE'` for an app a personal app cannot become, or
 * whose content the person cannot read.
 *
 * @param {string} appId
 * @returns {Promise<object>}
 */
const fetchApp = async appId => {
  const app = await plain(() => fetchUserApp(appId));
  if (!isCopyableAsUserApp(app)) throw notCopyableError(appId);
  return copySourceOf(app);
};

/** The source of the personal create page; the shape is that of `adminAppSource`. */
export const userAppSource = Object.freeze({
  kind: 'personal',
  fetchConfig,
  fetchTemplates,
  generateDraft,
  // A fresh list: a model that was connected a minute ago must be found.
  fetchModels: () => fetchModels({ skipCache: true }),
  createApp,
  fetchApp,
  fetchExistingApps,
  starts: Object.freeze({
    describe: true,
    templates: true,
    empty: true,
    copy: true,
    link: false,
    marketplace: false
  }),
  showAppId: false,
  showCategory: false,
  // The server lists only what this person may use in an app of their own.
  suggestions: Object.freeze({ webSearch: true, integrations: true }),
  copy: Object.freeze({
    stateLine: 'userApps.create.stateLine',
    submit: 'admin.apps.create.submit',
    limits: 'userApps.create.limits',
    // Every member of a personal app can read its instructions (design 6.4).
    instructionsHelp: 'userApps.edit.instructionsDesc',
    // What a copy takes differs from the admin copy: no sharing, no company-only settings.
    copyNote: 'userApps.create.copyNote',
    copyUnsupported: 'userApps.create.copyUnsupported'
  })
});

export default userAppSource;
