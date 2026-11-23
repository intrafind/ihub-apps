// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useMemo, useRef, useState } from 'react';
import { uniqueAppId } from '../../../../../../shared/appId.js';
import { CREATE_ERROR_KEYS, idError, readCreateFailure, validateDraft } from './createErrors.js';
import { derivedAppId, payloadFromState } from './createFlow.js';
import { FIELD_ORDER } from './createKeys.js';

const NO_SERVER_ANSWER = Object.freeze({ fields: {}, general: null });

/**
 * Validation and the create request of the "New app" page.
 *
 * When a message shows:
 * - never before input. A field shows its message once the author has typed
 *   in it and left it; the app ID shows it while the author types, because
 *   "already exists" is worth knowing at once;
 * - after a submit, every field that needs attention shows its message, and
 *   the page moves the focus to the summary (`focus.target === 'summary'`).
 *
 * The request: one `createApp(payload, { origin })`. When the server answers
 * that the ID is taken and the author never edited the ID, the next free ID
 * is tried once. When the author did edit it, the ID field gets the message
 * and the focus (`focus.target === 'id'`). Whatever happens, the input stays.
 *
 * @param {object} options
 * @param {object} options.state - The page's state (`useAppDraft`).
 * @param {(id: string) => void} options.deriveId - Sets an ID the page derived.
 * @param {(id: string) => boolean} options.isTaken - Whether an app has this ID.
 * @param {(id: string) => void} [options.markTaken] - Remembers an ID the server refused.
 * @param {(payload: object, options: { origin: string }) => Promise<object>} options.createApp
 * @param {(id: string, payload: object, info: { origin: string }) => void} options.onCreated -
 *   `origin` is how the app was started (`generated` for a draft from a description).
 * @param {(field: string) => string} [options.labelOf] - A field's label.
 * @param {(error: unknown) => string} [options.detailOf] - The server's own sentence.
 * @returns {object} See the return statement.
 */
export function useCreateSubmit({
  state,
  deriveId,
  isTaken,
  markTaken,
  createApp,
  onCreated,
  labelOf,
  detailOf
}) {
  // Fields that lost the focus at least once.
  const [left, setLeft] = useState([]);
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState(NO_SERVER_ANSWER);
  const [submitting, setSubmitting] = useState(false);
  // Where the page should move the focus: `{ target, nonce }`.
  const [focus, setFocus] = useState(null);
  const runningRef = useRef(false);

  const requestFocus = useCallback(
    target => setFocus(current => ({ target, nonce: (current?.nonce ?? 0) + 1 })),
    []
  );
  const clearFocus = useCallback(() => setFocus(null), []);

  const instructionsOptional = state.start === 'copy' && state.source?.noInstructions === true;

  const clientErrors = useMemo(
    () =>
      state.draft
        ? validateDraft(state.draft, {
            language: state.language,
            isTaken,
            instructionsOptional,
            idFollowsName: !state.idTouched
          })
        : {},
    [state.draft, state.language, state.idTouched, isTaken, instructionsOptional]
  );

  /** By field: `{ key, values }`; `key: null` marks a field the server refused. */
  const errors = useMemo(() => {
    const visible = {};
    for (const field of FIELD_ORDER) {
      const own = clientErrors[field];
      const shown =
        own &&
        (submitted ||
          (field === 'id'
            ? state.idTouched
            : left.includes(field) && state.edited.includes(field)));
      if (shown) visible[field] = own;
      else if (server.fields[field]) visible[field] = server.fields[field];
    }
    return visible;
  }, [clientErrors, server.fields, submitted, left, state.idTouched, state.edited]);

  const leave = useCallback(
    field => setLeft(fields => (fields.includes(field) ? fields : [...fields, field])),
    []
  );

  /** The author changed a field: what the server said about it no longer holds. */
  const touch = useCallback(field => {
    setServer(current => {
      if (!current.fields[field]) return current;
      const fields = { ...current.fields };
      delete fields[field];
      return { ...current, fields };
    });
  }, []);

  /** A new start: nothing was left, sent or refused yet. */
  const restart = useCallback(() => {
    setLeft([]);
    setSubmitted(false);
    setServer(NO_SERVER_ANSWER);
    setFocus(null);
  }, []);

  const submit = useCallback(async () => {
    if (runningRef.current || !state.draft) return;
    setSubmitted(true);
    setServer(NO_SERVER_ANSWER);
    if (Object.keys(clientErrors).length > 0) {
      requestFocus('summary');
      return;
    }

    runningRef.current = true;
    setSubmitting(true);
    let current = state;
    const refused = [];
    const taken = id => refused.includes(id) || isTaken(id);
    try {
      for (;;) {
        let payload;
        try {
          payload = payloadFromState(current);
        } catch (error) {
          if (error?.code !== 'APP_ID_INVALID') throw error;
          const problem = idError(current.draft.id, {
            name: current.draft.name?.[current.language]
          });
          setServer({ fields: problem ? { id: problem } : {}, general: null });
          requestFocus('id');
          return;
        }
        try {
          const created = await createApp(payload, { origin: current.start });
          onCreated(created?.id || payload.id, payload, { origin: current.start });
          return;
        } catch (error) {
          const failure = readCreateFailure(error, { id: payload.id, labelOf, detailOf });
          if (!failure.conflict) {
            setServer({ fields: failure.fields, general: failure.general });
            requestFocus('summary');
            return;
          }
          markTaken?.(payload.id);
          const firstConflict = refused.length === 0;
          refused.push(payload.id);
          if (current.idTouched || !firstConflict) {
            setServer({ fields: failure.fields, general: null });
            requestFocus('id');
            return;
          }
          // The author never chose this ID: take the next free one and try once more.
          const nextId =
            derivedAppId(current.draft.name?.[current.language], taken) ||
            uniqueAppId(payload.id, taken);
          deriveId(nextId);
          current = { ...current, draft: { ...current.draft, id: nextId } };
        }
      }
    } catch {
      // Not an answer of the server: the draft could not be turned into a request.
      setServer({
        fields: {},
        general: { key: CREATE_ERROR_KEYS.unknown, values: { detail: '' } }
      });
      requestFocus('summary');
    } finally {
      runningRef.current = false;
      setSubmitting(false);
    }
  }, [
    state,
    clientErrors,
    isTaken,
    markTaken,
    createApp,
    onCreated,
    labelOf,
    detailOf,
    deriveId,
    requestFocus
  ]);

  return {
    /** The messages to show now, by field. */
    errors,
    /** The message of the last request that belongs to no field: `{ key, values }` or null. */
    general: server.general,
    submitted,
    submitting,
    instructionsOptional,
    /** Whether a field lost the focus at least once. */
    hasLeft: field => left.includes(field),
    leave,
    touch,
    restart,
    submit,
    /** `{ target: 'summary' | <field>, nonce }` after a submit that could not go ahead. */
    focus,
    requestFocus,
    clearFocus
  };
}

export default useCreateSubmit;
