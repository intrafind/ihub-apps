// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuidv4 } from 'uuid';
import { fetchChat, removeHumanEvent, sendHumanEvent } from '../../../api';
import { useAnnounce } from '../../../shared/announce/AnnouncerProvider';
import { useToasts } from '../../../shared/components/ToastHost';
import { RUN_EVENTS } from '../../../../../shared/run/runReducer.js';

/** At most this many messages wait for one answer (`MAX_QUEUED_STEERS` on the server). */
export const MAX_WAITING_MESSAGES = 20;

/**
 * How long after the end of an answer the messages sent into it may still wait
 * for the frame that says what became of them, before the chat's read model is
 * asked (`pending[]` of `GET /api/chats/:chatId`).
 */
export const SETTLE_CHECK_MS = 3000;

/** The label of an item, per kind, as the server names it in `pending[]`. */
const LABEL_KEYS = Object.freeze({
  steer: 'chat.pending.steer',
  send_after: 'chat.pending.sendAfter'
});

/** The frames about a message for the running answer. */
const STEER_FRAMES = new Set([
  RUN_EVENTS.STEER_QUEUED,
  RUN_EVENTS.STEER_APPLIED,
  RUN_EVENTS.STEER_DROPPED
]);

/**
 * Whether an envelope is a `steer/*` frame.
 *
 * @param {Object} envelope - SSE v2 envelope
 * @returns {boolean}
 */
export function isSteerFrame(envelope) {
  return STEER_FRAMES.has(envelope?.type);
}

/**
 * An item of the server's `pending[]`, as the strip takes it; null for one it
 * cannot show (no id, no run to remove it under).
 *
 * @param {Object} item
 * @returns {Object|null}
 */
function pendingItemOf(item) {
  if (!item || typeof item.id !== 'string' || typeof item.runId !== 'string') return null;
  const kind = item.kind === 'send_after' ? 'send_after' : 'steer';
  return {
    id: item.id,
    runId: item.runId,
    kind,
    text: typeof item.text === 'string' ? item.text : '',
    labelKey: typeof item.labelKey === 'string' ? item.labelKey : LABEL_KEYS[kind],
    actions: Array.isArray(item.actions) ? item.actions : []
  };
}

/**
 * What became of the messages of an answer that ended, as far as the chat's
 * read model tells: the ones it no longer lists (`gone`), and of those the ones
 * the stored chat does not have as read (a message with their `steerId`), which
 * were dropped with `ended.reason` and give their text back.
 *
 * @param {Object} params
 * @param {Array<Object>} params.items - What the strip lists now
 * @param {Array<Object>} params.listed - What `pending[]` lists
 * @param {Object} params.readModel - The body of `GET /api/chats/:chatId`
 * @param {{runId: string, reason: string}} params.ended
 * @param {Set<string>} params.settled - Ids already done with
 * @returns {{gone: string[], notDelivered: Array<{id: string, text: string, reason: string|null}>}}
 */
export function goneAfterEnd({ items, listed, readModel, ended, settled }) {
  const listedIds = new Set(listed.map(item => item.id));
  const read = new Set(
    (Array.isArray(readModel?.messages) ? readModel.messages : [])
      .filter(message => message?.steer === true && typeof message.steerId === 'string')
      .map(message => message.steerId)
  );
  const lost = items.filter(
    item =>
      item.runId === ended.runId &&
      !item.sending &&
      !listedIds.has(item.id) &&
      !settled.has(item.id)
  );
  return {
    gone: lost.map(item => item.id),
    notDelivered: lost
      .filter(item => !read.has(item.id) && item.text)
      .map(item => ({ id: item.id, text: item.text, reason: ended.reason || null }))
  };
}

/**
 * Why a message for the running answer was not sent, in the person's language,
 * by the problem code or status of the refusal (`POST /api/runs/{runId}/human-events`).
 * The server's `detail` is English and is never shown; a refusal this client
 * does not know gets the general text.
 *
 * @param {Function} t
 * @param {{status?: number, code?: string}|null|undefined} error
 * @returns {string}
 */
export function notSentText(t, error) {
  const code = error?.code;
  const status = error?.status;
  if (code === 'RUN_STEER_FORBIDDEN' || status === 403) {
    return t(
      'chat.steer.notSentForbidden',
      'Not sent: only the person this answer is written for can add a message to it.'
    );
  }
  if (code === 'RUN_NOT_ACTIVE') {
    return t('chat.steer.notSentApproval', 'Not sent: answer the approval above first.');
  }
  if (status === 400) {
    return t(
      'chat.steer.notSentInvalid',
      'Not sent: the message could not be taken. Shorten it and try again.'
    );
  }
  if (status === 429) {
    return t(
      'chat.steer.notSentTooMany',
      'Not sent: too many messages in a short time. Please wait a moment.'
    );
  }
  if (status === 503) {
    return t('chat.steer.notSentBusy', 'Not sent: iHub is busy. Please try again in a moment.');
  }
  return t('chat.steer.notSentRetry', 'Not sent. Please try again.');
}

/**
 * The messages the person sends into the running answer of a chat (#3191):
 * what waits, what was not delivered, and whether the person may send at all.
 *
 * The server decides every part of it. `maySteer` and what waits come from the
 * chat's read model (`GET /api/chats/:chatId`, {@link adopt}); while the answer
 * runs, the `steer/*` frames of its stream say what became of each message
 * ({@link onFrame}): read at a step, sent as the next message, or dropped with
 * its text, which the chat gives back ("Copy to input"). A message the person
 * sends shows at once, marked as being sent, and takes the id the server
 * answers with.
 *
 * What it says to a screen reader goes through the page's one announcer
 * (`useAnnounce`); the refusal of a removal ("Already read by iHub") is a toast.
 *
 * @param {Object} options
 * @param {string} options.chatId - The chat on screen
 * @returns {Object} See the returned fields
 */
function useRunSteering({ chatId }) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const { show: showToast } = useToasts();
  const [items, setItems] = useState([]);
  const [dropped, setDropped] = useState([]);
  const [maySteer, setMaySteer] = useState(null);
  // Another chat: nothing of the one left is shown (adjusted while rendering).
  const [shownChatId, setShownChatId] = useState(chatId);
  if (shownChatId !== chatId) {
    setShownChatId(chatId);
    setItems([]);
    setDropped([]);
    setMaySteer(null);
  }
  // The list as of now, for the stream's questions between two renders.
  const itemsRef = useRef([]);
  // Ids that were read, sent, dropped or removed: a late frame or answer never
  // brings one back.
  const settledRef = useRef(new Set());
  const chatRef = useRef(chatId);
  const timersRef = useRef(new Set());

  const updateItems = useCallback(update => {
    const next = typeof update === 'function' ? update(itemsRef.current) : update;
    itemsRef.current = next;
    setItems(next);
  }, []);

  // Another chat: nothing of the one left is asked about.
  useEffect(() => {
    chatRef.current = chatId;
    settledRef.current = new Set();
    itemsRef.current = [];
  }, [chatId]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /** Mark an id as done with and take it off the list. */
  const settle = useCallback(
    id => {
      settledRef.current.add(id);
      updateItems(list => list.filter(item => item.id !== id));
    },
    [updateItems]
  );

  /**
   * Take what the chat's read model says: `maySteer` (absent: the feature is
   * off, read as false) and `pending[]`. Messages being sent stay.
   *
   * With `ended`, the answer `ended.runId` is over and the caller knows what
   * became of what still waited for it (`ended.reason`, one of
   * `STEER_DROP_REASONS`): a message of that answer that `pending[]` no longer
   * lists and that the stored chat does not have as read (a message with its
   * `steerId`) was dropped with that reason. Its frame did not reach this page
   * (a stopped answer's stream closes at once), so its text comes back as a
   * notice instead of going silently.
   *
   * @param {Object|null} readModel - The body of `GET /api/chats/:chatId`
   * @param {Object} [options]
   * @param {{runId: string, reason: string}} [options.ended]
   */
  const adopt = useCallback(
    (readModel, { ended = null } = {}) => {
      if (!readModel || typeof readModel !== 'object') return;
      setMaySteer(readModel.maySteer === true);
      const listed = (Array.isArray(readModel.pending) ? readModel.pending : [])
        .map(item => pendingItemOf(item))
        .filter(item => item && !settledRef.current.has(item.id));
      if (ended?.runId) {
        const { gone, notDelivered } = goneAfterEnd({
          items: itemsRef.current,
          listed,
          readModel,
          ended,
          settled: settledRef.current
        });
        for (const id of gone) settledRef.current.add(id);
        if (notDelivered.length > 0) {
          setDropped(list => [
            ...list,
            ...notDelivered.filter(entry => !list.some(known => known.id === entry.id))
          ]);
          announce(t('chat.steer.announceDropped', 'Your message was not delivered'));
        }
      }
      updateItems(list => [...listed, ...list.filter(item => item.sending)]);
    },
    [announce, updateItems, t]
  );

  /**
   * Ask the chat's read model again.
   *
   * @param {Object} [options] - See {@link adopt}
   */
  const refresh = useCallback(
    async (options = {}) => {
      const requested = chatRef.current;
      if (!requested) return;
      try {
        const body = await fetchChat(requested);
        if (chatRef.current === requested) adopt(body, options);
      } catch {
        // What is listed stays; the next frame or read corrects it.
      }
    },
    [adopt]
  );

  /**
   * Send a message into the running answer: read at its next step, or with
   * `mode: 'afterwards'` sent as the next message once it is done.
   *
   * @param {string} runId - The running answer
   * @param {string} text
   * @param {'steer'|'afterwards'} [mode='steer']
   * @returns {Promise<{delivered: boolean, id?: string, error?: Error}>} `delivered: false`
   *   without an error: no answer was running to take it (send it as a new message)
   */
  const send = useCallback(
    async (runId, text, mode = 'steer') => {
      const kind = mode === 'afterwards' ? 'send_after' : 'steer';
      const tempId = `sending-${uuidv4()}`;
      updateItems(list => [
        ...list,
        { id: tempId, runId, kind, text, labelKey: LABEL_KEYS[kind], actions: [], sending: true }
      ]);
      const dropTemp = () => updateItems(list => list.filter(item => item.id !== tempId));
      try {
        const body = await sendHumanEvent(runId, {
          kind: 'steer',
          message: text,
          ...(mode === 'afterwards' ? { mode } : {})
        });
        if (typeof body?.id !== 'string') {
          dropTemp();
          return { delivered: false };
        }
        const id = body.id;
        updateItems(list => {
          const rest = list.filter(item => item.id !== tempId);
          // Already listed by its frame, or already read: nothing to add.
          if (settledRef.current.has(id) || rest.some(item => item.id === id)) return rest;
          const at = list.findIndex(item => item.id === tempId);
          const entry = {
            id,
            runId,
            kind,
            text,
            labelKey: LABEL_KEYS[kind],
            actions: ['remove']
          };
          if (at === -1) return [...rest, entry];
          return [...list.slice(0, at), entry, ...list.slice(at + 1)];
        });
        announce(
          kind === 'send_after'
            ? t('chat.steer.announceSendAfter', 'Your message will be sent as the next message')
            : t('chat.steer.announceQueued', 'Your message will be read at the next step')
        );
        return { delivered: true, id };
      } catch (error) {
        dropTemp();
        return { delivered: false, error };
      }
    },
    [announce, updateItems, t]
  );

  /**
   * Remove a message that waits. Read already (409 `STEER_ALREADY_APPLIED`):
   * it leaves the list and a toast says so.
   *
   * @param {Object} item - An item of {@link items}
   */
  const remove = useCallback(
    async item => {
      if (!item?.id || item.sending) return;
      try {
        await removeHumanEvent(item.runId, item.id);
        settle(item.id);
        announce(t('chat.steer.announceRemoved', 'Your message was removed'));
      } catch (error) {
        if (error?.status === 409 || error?.code === 'STEER_ALREADY_APPLIED') {
          settle(item.id);
          showToast({
            id: `steer-read-${item.id}`,
            text: t('chat.steer.alreadyRead', 'Already read by iHub'),
            icon: 'chat-bubble-left'
          });
        } else if (error?.status === 404) {
          // It no longer waits (the frame that said so did not reach this page):
          // it will not be read, which is what the person asked for.
          settle(item.id);
          announce(t('chat.steer.announceRemoved', 'Your message was removed'));
        } else {
          showToast({
            id: `steer-remove-${item.id}`,
            text: t(
              'chat.steer.removeFailed',
              'The message could not be removed right now. Please try again.'
            ),
            tone: 'danger'
          });
        }
      }
    },
    [announce, settle, showToast, t]
  );

  /**
   * Take a `steer/*` frame of the chat's stream.
   *
   * @param {Object} envelope - SSE v2 envelope
   */
  const onFrame = useCallback(
    envelope => {
      if (!isSteerFrame(envelope)) return;
      const data = envelope.data || {};
      const id = typeof data.id === 'string' ? data.id : null;
      if (!id) return;
      if (envelope.type === RUN_EVENTS.STEER_QUEUED) {
        if (settledRef.current.has(id)) return;
        const kind = data.kind === 'send_after' ? 'send_after' : 'steer';
        const text = typeof data.text === 'string' ? data.text : '';
        updateItems(list => {
          if (list.some(item => item.id === id)) return list;
          const entry = {
            id,
            runId: envelope.runId,
            kind,
            text,
            labelKey: LABEL_KEYS[kind],
            actions: ['remove']
          };
          // The message this page is sending: its frame came before its answer.
          const at = list.findIndex(
            item => item.sending && item.kind === kind && item.text === text
          );
          if (at === -1) return [...list, entry];
          return [...list.slice(0, at), { ...entry, runId: list[at].runId }, ...list.slice(at + 1)];
        });
        return;
      }
      if (settledRef.current.has(id)) return;
      settle(id);
      if (envelope.type === RUN_EVENTS.STEER_APPLIED) {
        announce(
          typeof data.nextRunId === 'string'
            ? t('chat.steer.announceSentNext', 'Your message was sent as the next message')
            : t('chat.steer.announceRead', 'iHub read your message')
        );
        return;
      }
      // Dropped: removed by the person says nothing more; anything else gives the text back.
      if (data.reason === 'removed' || typeof data.text !== 'string' || !data.text) return;
      setDropped(list =>
        list.some(entry => entry.id === id)
          ? list
          : [...list, { id, text: data.text, reason: data.reason || null }]
      );
      announce(t('chat.steer.announceDropped', 'Your message was not delivered'));
    },
    [announce, updateItems, settle, t]
  );

  /**
   * Whether messages sent into `runId` still wait for the frame that says what
   * became of them.
   *
   * @param {string} runId
   * @returns {boolean}
   */
  const hasWaitingFor = useCallback(
    runId => itemsRef.current.some(item => item.runId === runId && !item.sending),
    []
  );

  /**
   * The answer `runId` ended: when messages sent into it are still listed a
   * moment later (their frame did not reach this page), ask the read model.
   * With `reason` (the person stopped the answer: `run_stopped`), what the read
   * model no longer lists was dropped for it and comes back as a notice.
   *
   * @param {string} runId
   * @param {Object} [options]
   * @param {string} [options.reason] - What became of what still waited, when the caller knows.
   */
  const checkAfterEnd = useCallback(
    (runId, { reason = null } = {}) => {
      if (!hasWaitingFor(runId)) return;
      const requested = chatRef.current;
      const timer = setTimeout(() => {
        timersRef.current.delete(timer);
        if (chatRef.current !== requested || !hasWaitingFor(runId)) return;
        void refresh(reason ? { ended: { runId, reason } } : {});
      }, SETTLE_CHECK_MS);
      timersRef.current.add(timer);
    },
    [hasWaitingFor, refresh]
  );

  /** Close the notice of a message that was not delivered. */
  const dismissDropped = useCallback(id => {
    setDropped(list => list.filter(entry => entry.id !== id));
  }, []);

  return useMemo(
    () => ({
      items,
      dropped,
      maySteer,
      full: items.length >= MAX_WAITING_MESSAGES,
      adopt,
      refresh,
      send,
      remove,
      onFrame,
      hasWaitingFor,
      checkAfterEnd,
      dismissDropped
    }),
    [
      items,
      dropped,
      maySteer,
      adopt,
      refresh,
      send,
      remove,
      onFrame,
      hasWaitingFor,
      checkAfterEnd,
      dismissDropped
    ]
  );
}

export default useRunSteering;
