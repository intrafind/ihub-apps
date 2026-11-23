// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  REVISE_CONVERSATION_MAX,
  applyRevisionPatch
} from '../../../../../../shared/appRevision.js';
import {
  EMPTY_CONVERSATION,
  changeKeysOf,
  changesOf,
  conversationStorageKey,
  draftOf,
  readConversation,
  restoreValues,
  valuesOf,
  wireConversation,
  writeConversation
} from './conversationState';
import { reviseErrorMessage } from './reviseErrors';

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @typedef {object} ConversationEntry
 * @property {number} id
 * @property {'author'|'builder'} role
 * @property {'question'|'change'|'message'} [kind] - Builder entries only.
 * @property {string} text
 * @property {{ text: string, choices: string[], allowOther: boolean }} [question]
 * @property {object} [patch] - A change: whole values of the changed keys.
 * @property {string[]} [changed]
 * @property {object[]} [warnings]
 * @property {object} [suggestions]
 * @property {object} [baseSnapshot] - A change: the content the turn sent.
 * @property {'proposed'|'applying'|'applied'|'dismissed'|'undoing'|'undone'} [status]
 * @property {'conflict'|'failed'|null} [problem] - Why the last Apply or Undo did not save.
 * @property {string|null} [problemText] - The sentence of a failed save.
 * @property {{ values: object, missing: string[] }} [before] - What Apply replaced.
 * @property {{ values: object }} [applied] - What Apply saved.
 */

/**
 * The state of the app builder's conversation for one app: the entries, the
 * turn that is running, and the actions of the panel (send, answer, skip,
 * apply, dismiss, undo, cancel, start over).
 *
 * A turn sends the form's content (`draft`) and the conversation to
 * `refine` (the source's `refineDraft`, `_revise`), and adds the answer as
 * one builder entry. A change keeps the content the turn sent
 * (`baseSnapshot`): Apply is offered only while the form still holds it.
 *
 * Apply merges the change, plus the ticked suggestions, over the form and
 * hands the result to `persist`, the editor's own save. Undo hands back the
 * values the change replaced, through the same save. Neither writes anything
 * itself; `persist` decides and says what happened.
 *
 * The conversation is kept per app in `sessionStorage` (its last 12 entries),
 * so a reload of the editor keeps it; "Start over" clears it.
 *
 * @param {object} options
 * @param {string} options.appId
 * @param {'admin'|'personal'} options.target
 * @param {object|null} options.form - The app as the editor holds it now.
 * @param {string} options.language - The content language of the app.
 * @param {(request: object) => Promise<object>} options.refine - One turn (`refineDraft`).
 * @param {(next: object, change: { keys: string[] }) => Promise<{ status: 'saved'|'conflict'|'failed', value?: object, message?: string|null }>} options.persist -
 *   Puts `next` into the form and saves it. `change.keys` are the keys the
 *   change writes: any other key of `next` that differs from the saved app is
 *   an unsaved edit of the author that goes with it (`unsavedOutsideChange`).
 *   `value` is the form as saved, when the save normalised it.
 * @returns {object} See the members below.
 *
 * @example
 * const conversation = useConversation({ appId, target: 'admin', form: app, language: 'en',
 *   refine: adminAppSource.refineDraft, persist: applyAndSave });
 * conversation.send('Make it more formal');
 */
export function useConversation({ appId, target, form, language, refine, persist }) {
  const storageKey = conversationStorageKey(target, appId);
  const [state, setState] = useState(() => ({
    key: storageKey,
    ...readConversation(storageKey)
  }));
  // Another app: its own conversation.
  if (state.key !== storageKey) setState({ key: storageKey, ...readConversation(storageKey) });
  const current = state.key === storageKey ? state : { key: storageKey, ...EMPTY_CONVERSATION };

  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  // The entry whose Apply just saved: the panel moves the focus to its "Applied" line.
  const [justApplied, setJustApplied] = useState(null);
  const controllerRef = useRef(null);

  const latestRef = useRef({ form, language, refine, persist, current });
  latestRef.current = { form, language, refine, persist, current };

  useEffect(() => {
    writeConversation(storageKey, {
      entries: current.entries,
      turns: current.turns,
      nextId: current.nextId
    });
  }, [storageKey, current.entries, current.turns, current.nextId]);

  // A turn that runs when the editor goes away is cancelled with it.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const change = useCallback(
    update =>
      setState(held => {
        if (held.key !== storageKey) return held;
        const next = update(held);
        return {
          ...next,
          entries: next.entries.slice(-REVISE_CONVERSATION_MAX)
        };
      }),
    [storageKey]
  );

  const updateEntry = useCallback(
    (id, patch) =>
      change(held => ({
        ...held,
        entries: held.entries.map(entry =>
          entry.id === id
            ? { ...entry, ...(typeof patch === 'function' ? patch(entry) : patch) }
            : entry
        )
      })),
    [change]
  );

  /** Asks for the answer to the conversation as it stands, with the author's entry last. */
  const runTurn = useCallback(
    async entries => {
      const latest = latestRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const baseSnapshot = draftOf(latest.form, target);
      setWorking(true);
      setError(null);
      try {
        const answer = await latest.refine({
          draft: baseSnapshot,
          conversation: wireConversation(entries),
          language: latest.language,
          signal: controller.signal
        });
        if (controller.signal.aborted) return;
        change(held => {
          const entry = builderEntry(answer, held.nextId, baseSnapshot);
          return { ...held, entries: [...held.entries, entry], nextId: held.nextId + 1 };
        });
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(reviseErrorMessage(failure));
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setWorking(false);
        }
      }
    },
    [change, target]
  );

  /**
   * Sends the author's message: it becomes an entry, and the builder answers.
   *
   * @param {string} text
   * @returns {boolean} Whether a turn started.
   */
  const send = useCallback(
    text => {
      const message = typeof text === 'string' ? text.trim() : '';
      if (!message || controllerRef.current) return false;
      const held = latestRef.current.current;
      const entry = { id: held.nextId, role: 'author', text: message };
      const entries = [...held.entries, entry];
      change(prev => ({
        ...prev,
        entries: [...prev.entries, entry],
        turns: prev.turns + 1,
        nextId: prev.nextId + 1
      }));
      void runTurn(entries);
      return true;
    },
    [change, runTurn]
  );

  /** Asks again for the answer to the last message, after a failed turn. */
  const retry = useCallback(() => {
    const { entries } = latestRef.current.current;
    if (controllerRef.current || entries.length === 0) return;
    void runTurn(entries);
  }, [runTurn]);

  /** Stops the turn that is running; the author's message stays. */
  const cancel = useCallback(() => {
    if (!controllerRef.current) return;
    controllerRef.current.abort();
    controllerRef.current = null;
    setWorking(false);
  }, []);

  /** Clears the conversation of this app, here and in the tab's storage. */
  const startOver = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setWorking(false);
    setError(null);
    setJustApplied(null);
    change(held => ({ ...held, ...EMPTY_CONVERSATION }));
  }, [change]);

  /** Closes a proposed change without applying it. */
  const dismiss = useCallback(id => updateEntry(id, { status: 'dismissed' }), [updateEntry]);

  /**
   * Applies a proposed change, with the suggestions the author ticked, and
   * saves the app through the editor's save.
   *
   * @param {number} id - The change entry.
   * @param {{ webSearch?: boolean, integrationIds?: string[] }} [ticked]
   * @returns {Promise<string>} The outcome: `saved`, `conflict`, `failed` or `refused`.
   */
  const apply = useCallback(
    async (id, ticked) => {
      const latest = latestRef.current;
      const entry = latest.current.entries.find(item => item.id === id);
      const formNow = latest.form;
      if (!entry || entry.kind !== 'change' || !formNow) return 'refused';
      if (entry.status !== 'proposed') return 'refused';
      const changes = changesOf(target, formNow, entry, ticked);
      const keys = Object.keys(changes);
      if (keys.length === 0) return 'refused';
      const before = valuesOf(formNow, keys);
      updateEntry(id, { status: 'applying', problem: null, problemText: null });
      const outcome = await latest.persist(applyRevisionPatch(formNow, changes), { keys });
      if (outcome?.status === 'saved') {
        const saved = isPlainObject(outcome.value)
          ? outcome.value
          : applyRevisionPatch(formNow, changes);
        // The newest applied change is the only one Undo is offered on.
        change(held => ({
          ...held,
          entries: held.entries.map(item =>
            item.id === id
              ? {
                  ...item,
                  status: 'applied',
                  before,
                  applied: valuesOf(saved, keys)
                }
              : item.status === 'applied'
                ? { ...item, status: 'kept' }
                : item
          )
        }));
        setJustApplied({ id });
        return 'saved';
      }
      updateEntry(id, {
        status: 'proposed',
        problem: outcome?.status === 'conflict' ? 'conflict' : 'failed',
        problemText: outcome?.message || null
      });
      return outcome?.status || 'failed';
    },
    [change, target, updateEntry]
  );

  /**
   * Puts back what an applied change replaced, through the same save.
   *
   * @param {number} id
   * @returns {Promise<string>} `saved`, `conflict`, `failed` or `refused`.
   */
  const undo = useCallback(
    async id => {
      const latest = latestRef.current;
      const entry = latest.current.entries.find(item => item.id === id);
      const formNow = latest.form;
      if (!entry || entry.status !== 'applied' || !formNow || !entry.before) return 'refused';
      updateEntry(id, { status: 'undoing', problem: null, problemText: null });
      const outcome = await latest.persist(restoreValues(formNow, entry.before), {
        keys: changeKeysOf(target, formNow, entry)
      });
      if (outcome?.status === 'saved') {
        updateEntry(id, { status: 'undone' });
        setJustApplied({ id });
        return 'saved';
      }
      updateEntry(id, {
        status: 'applied',
        problem: outcome?.status === 'conflict' ? 'conflict' : 'failed',
        problemText: outcome?.message || null
      });
      return outcome?.status || 'failed';
    },
    [target, updateEntry]
  );

  return {
    entries: current.entries,
    turns: current.turns,
    working,
    error,
    justApplied,
    send,
    retry,
    cancel,
    startOver,
    dismiss,
    apply,
    undo
  };
}

/**
 * The builder entry of an answer. A change without a patch is a message (the
 * server answers `message` for that, this guards against an answer that does
 * not).
 *
 * @param {object} answer - The response of `_revise`.
 * @param {number} id
 * @param {object} baseSnapshot - The content the turn sent.
 * @returns {ConversationEntry}
 */
export function builderEntry(answer, id, baseSnapshot) {
  const reply = answer?.reply;
  const text = typeof answer?.text === 'string' ? answer.text : '';
  const warnings = Array.isArray(answer?.warnings) ? answer.warnings.filter(isPlainObject) : [];
  if (reply === 'question' && isPlainObject(answer.question)) {
    const question = answer.question;
    return {
      id,
      role: 'builder',
      kind: 'question',
      text,
      question: {
        text: typeof question.text === 'string' ? question.text : text,
        choices: Array.isArray(question.choices)
          ? question.choices.filter(choice => typeof choice === 'string' && choice.trim() !== '')
          : [],
        allowOther: question.allowOther !== false
      },
      status: 'open'
    };
  }
  const patch = isPlainObject(answer?.patch) ? answer.patch : {};
  if (reply === 'change' && Object.keys(patch).length > 0) {
    return {
      id,
      role: 'builder',
      kind: 'change',
      text,
      patch,
      changed: Array.isArray(answer.changed)
        ? answer.changed.filter(key => Object.hasOwn(patch, key))
        : Object.keys(patch),
      warnings,
      suggestions: isPlainObject(answer.suggestions) ? answer.suggestions : {},
      baseSnapshot,
      status: 'proposed'
    };
  }
  return { id, role: 'builder', kind: 'message', text, warnings };
}

export default useConversation;
