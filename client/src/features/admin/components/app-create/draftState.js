// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The state of the "New app" page between its two screens, as a reducer, and
 * the form in which it is kept for the browser tab.
 *
 * The state holds an app configuration (`draft`) and, beside it, what the
 * page needs to know about how it came to be: the start, the language the
 * screen edits, the description for the AI, what the author ticked, and which
 * fields the author changed. Nothing of that is written into the draft, so no
 * key has to be stripped before the create request.
 *
 * Pure, and free of any admin-only assumption: no React, no browser API, no
 * request, no path.
 *
 * @module features/admin/components/app-create/draftState
 */

import { draftForLink } from '../../utils/appDraft.js';
import { SCREENS, START_KINDS } from './createKeys.js';
import { isLinkDraft, linkUrlOf } from './createErrors.js';

/**
 * What the author ticked in the notice of an AI draft.
 *
 * @typedef {Object} DraftExtrasChoice
 * @property {boolean} inputFields - Keep the input fields the AI proposed.
 * @property {boolean} webSearch - Switch on web search (a suggestion).
 * @property {string[]} integrationIds - The suggested connected systems to bind.
 */

/** Nothing is on unless the author ticks it; proposed input fields stay. */
export const INITIAL_EXTRAS = Object.freeze({
  inputFields: true,
  webSearch: false,
  integrationIds: Object.freeze([])
});

/** The texts of the Essentials screen that are stored per language. */
const TEXT_FIELDS = ['name', 'description', 'system'];

/** Icon, colour and category: plain values of the app. */
const META_FIELDS = ['icon', 'color', 'category'];

/** Raised when the stored shape changes; an older entry is then ignored. */
const STORAGE_VERSION = 1;

/**
 * The state of a page that was just opened.
 *
 * @returns {object}
 */
export function initialDraftState() {
  return {
    /** `start` or `essentials`. */
    screen: 'start',
    /** One of `START_KINDS`, or null on the Start screen. */
    start: null,
    /** The language the Essentials screen edits. */
    language: null,
    /** The app configuration, or null on the Start screen. */
    draft: null,
    /** The template or the copied app: `{ id, name, noInstructions? }`. */
    source: null,
    /** What the author wrote for the AI. */
    description: '',
    /** The answer of the draft request: `{ app, suggestions, warnings, model }`. */
    generated: null,
    extras: { ...INITIAL_EXTRAS, integrationIds: [] },
    /** The author edited the app ID; it no longer follows the name. */
    idTouched: false,
    /** The fields the author changed on the Essentials screen. */
    edited: [],
    /** The author typed or changed something on the Essentials screen. */
    dirty: false,
    /** The state came back from the tab's storage after a reload. */
    restored: false
  };
}

const withEdit = (state, field) =>
  state.edited.includes(field) ? state.edited : [...state.edited, field];

/** The draft of a link app with another address or another way to open it. */
function editedLink(state, { url, mode }) {
  const draft = { ...state.draft };
  const address = typeof url === 'string' ? url : linkUrlOf(draft);
  const type = mode === 'iframe' || mode === 'redirect' ? mode : draft.type;
  if (type === draft.type) {
    const key = type === 'iframe' ? 'iframeConfig' : 'redirectConfig';
    draft[key] = { ...draft[key], url: address };
    return draft;
  }
  const fresh = draftForLink({ language: state.language, mode: type, url: address });
  delete draft.iframeConfig;
  delete draft.redirectConfig;
  draft.type = fresh.type;
  if (fresh.iframeConfig) draft.iframeConfig = fresh.iframeConfig;
  if (fresh.redirectConfig) draft.redirectConfig = fresh.redirectConfig;
  return draft;
}

/**
 * The reducer of the page's state.
 *
 * Actions:
 * - `begin` `{ start, draft, language, source?, generated?, description? }`:
 *   a start was chosen; the Essentials screen opens with this draft.
 * - `describe` `{ description }`: the author typed in a description box.
 * - `text` `{ field, value, id? }`: name, short description or instructions
 *   in the screen's language. `id` is the app ID derived from a new name.
 * - `meta` `{ field, value }`: icon, colour or category.
 * - `id` `{ value, touched }`: the app ID. `touched: false` is an ID the page
 *   derived, which does not count as an edit.
 * - `link` `{ url?, mode? }`: the address of a link app, or how it opens.
 * - `extras` `{ extras }`: what the author ticked in the draft notice.
 * - `back`: to the Start screen. The description stays.
 * - `reset`: everything empty ("Start over", and after the app was created).
 *
 * @param {object} state
 * @param {{ type: string }} action
 * @returns {object}
 */
export function draftReducer(state, action) {
  switch (action.type) {
    case 'begin':
      return {
        ...initialDraftState(),
        screen: 'essentials',
        start: action.start,
        language: action.language,
        draft: action.draft,
        source: action.source ?? null,
        generated: action.generated ?? null,
        description: action.description ?? state.description
      };
    case 'describe':
      return { ...state, description: action.description };
    case 'text': {
      if (!state.draft || !TEXT_FIELDS.includes(action.field)) return state;
      const draft = {
        ...state.draft,
        [action.field]: { ...state.draft[action.field], [state.language]: action.value }
      };
      if (action.field === 'name' && !state.idTouched && typeof action.id === 'string') {
        draft.id = action.id;
      }
      return { ...state, draft, edited: withEdit(state, action.field), dirty: true };
    }
    case 'meta':
      if (!state.draft || !META_FIELDS.includes(action.field)) return state;
      return {
        ...state,
        draft: { ...state.draft, [action.field]: action.value },
        edited: withEdit(state, action.field),
        dirty: true
      };
    case 'id':
      if (!state.draft) return state;
      if (!action.touched) {
        if (state.idTouched || state.draft.id === action.value) return state;
        return { ...state, draft: { ...state.draft, id: action.value } };
      }
      return {
        ...state,
        draft: { ...state.draft, id: action.value },
        idTouched: true,
        edited: withEdit(state, 'id'),
        dirty: true
      };
    case 'link': {
      if (!isLinkDraft(state.draft)) return state;
      const field = action.mode === undefined ? 'url' : 'mode';
      return {
        ...state,
        draft: editedLink(state, action),
        edited: withEdit(state, field),
        dirty: true
      };
    }
    case 'extras':
      return { ...state, extras: { ...state.extras, ...action.extras }, dirty: true };
    case 'back':
      return { ...initialDraftState(), description: state.description };
    case 'reset':
      return initialDraftState();
    default:
      return state;
  }
}

/** Whether the state holds anything a reload should bring back. */
function worthKeeping(state) {
  return state.screen === 'essentials' || state.description.trim() !== '';
}

/**
 * The state as it is written to the tab's storage.
 *
 * @param {object} state
 * @returns {string|null} JSON, or null when there is nothing to keep.
 */
export function serializeDraftState(state) {
  if (!worthKeeping(state)) return null;
  const { restored, ...kept } = state;
  void restored;
  return JSON.stringify({ version: STORAGE_VERSION, state: kept });
}

/**
 * The state a stored entry stands for, or null when the entry is missing,
 * from another version or not a state this page could have written.
 *
 * @param {string|null|undefined} text
 * @returns {object|null}
 */
export function parseDraftState(text) {
  if (typeof text !== 'string' || text === '') return null;
  let stored;
  try {
    stored = JSON.parse(text);
  } catch {
    return null;
  }
  const saved = stored?.state;
  if (stored?.version !== STORAGE_VERSION || !saved || typeof saved !== 'object') return null;
  if (!SCREENS.includes(saved.screen) || typeof saved.description !== 'string') return null;
  if (saved.screen === 'essentials') {
    const usable =
      START_KINDS.includes(saved.start) &&
      typeof saved.language === 'string' &&
      saved.draft &&
      typeof saved.draft === 'object' &&
      !Array.isArray(saved.draft);
    if (!usable) return null;
  }
  const base = initialDraftState();
  const state = {
    ...base,
    ...Object.fromEntries(Object.entries(saved).filter(([key]) => key in base)),
    extras: {
      ...base.extras,
      ...(saved.extras && typeof saved.extras === 'object' ? saved.extras : {})
    },
    edited: Array.isArray(saved.edited) ? saved.edited.filter(f => typeof f === 'string') : [],
    restored: true
  };
  if (!Array.isArray(state.extras.integrationIds)) state.extras.integrationIds = [];
  return worthKeeping(state) ? state : null;
}
