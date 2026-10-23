// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useCallback, useRef, useEffect } from 'react';
import { debugLog } from '../../../utils/debugLog';
import { generatedFilesFromArtifacts } from '../../../../../shared/generatedFiles.js';
import { storedSourceSet } from '../../../../../shared/sources/index.js';

/**
 * The provenance fields a stored answer's `activity` restores onto the message
 * (see `shared/run/runActivity.buildRunActivity`).
 */
const STORED_ACTIVITY_FIELDS = [
  'toolActivity',
  'searchSummary',
  'activeSkills',
  'answerSource',
  'knowledgeScope',
  'workflowSteps',
  'workflowResult',
  'outputFormat'
];

/**
 * One message of a stored chat transcript, as the chat UI renders it.
 *
 * Shape on the wire (`GET /api/chats/:chatId` → `messages[]`):
 * `{ id, role, content, ts, runId, clientMessageId?, usage?, finishReason?,
 * error?, attachments?, artifacts?, mcpApps?, sources?, activity? }`.
 *
 * The stored id is adopted as the message id and kept a second time on
 * `serverId`: `replaceFromMessageId` addresses the server's history by that
 * id, and a locally minted `user-<ts>-<rand>` means nothing to the store.
 *
 * An artifact is anything the turn produced that is content in its own right —
 * a generated image, or a file a system skill tool generated (kind
 * `document`, surfaced as `generatedFiles`). Its descriptor carries no payload:
 * `{ id, kind, mimeType, bytes }`, or `{ kind, mimeType, bytes, unavailable }`
 * for one the server declined to store. The bytes are fetched per artifact
 * when the message is rendered, so a transcript with a dozen pictures in it
 * still arrives in one small response.
 *
 * The image-kind artifacts are also surfaced as `images`, which is the field
 * the chat bubble renders and the one a live turn fills from its own stream —
 * so a reopened message and a just-answered one take the same render path.
 *
 * @param {Object} msg - Stored message.
 * @returns {Object} Chat message.
 */
export function transformStoredMessage(msg) {
  const message = {
    id: msg.id,
    serverId: msg.id,
    role: msg.role === 'user' || msg.role === 'system' ? msg.role : 'assistant',
    content: typeof msg.content === 'string' ? msg.content : '',
    loading: false,
    fromServer: true
  };

  if (msg.ts) message.ts = msg.ts;
  if (msg.runId) message.runId = msg.runId;
  // The email (or meeting) a chat handed over from the Outlook pane was about.
  // The store never keeps one; a hand-off does, so that a chat that is not
  // stored sends it back with its history and the model still has the email.
  if (msg.role === 'user' && msg.hostContext && typeof msg.hostContext === 'object') {
    message.hostContext = msg.hostContext;
  }
  if (msg.usage) message.usage = msg.usage;
  if (msg.finishReason) message.finishReason = msg.finishReason;
  // A transcription turn (its audio is not kept: no edit, no resend).
  if (msg.transcription === true) message.transcription = true;
  // A turn spoken in voice mode: the bubble marks it with the waveform icon.
  if (msg.role === 'user' && msg.metadata?.inputMode === 'voice') {
    message.metadata = { inputMode: 'voice' };
  }
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    message.attachments = msg.attachments;
  }
  // Interactive MCP App views of the answer, redrawn from their stored data.
  if (Array.isArray(msg.mcpApps) && msg.mcpApps.length > 0) message.mcpApps = msg.mcpApps;
  // Connect cards for MCP servers with per-user sign-in.
  if (Array.isArray(msg.mcpAuthRequired) && msg.mcpAuthRequired.length > 0) {
    message.mcpAuthRequired = msg.mcpAuthRequired;
  }
  // Confirmation cards for scheduled tasks a scheduling tool proposed.
  if (Array.isArray(msg.scheduledTaskProposals) && msg.scheduledTaskProposals.length > 0) {
    message.scheduledTaskProposals = msg.scheduledTaskProposals;
  }
  // Everything the answer found, so the sources panel and the inline
  // citations come back (the citation markers are in the content). The badge
  // is the stored activity's below, never inferred from what was found.
  const sources = storedSourceSet(msg.sources);
  if (sources) message.sources = sources;
  // What the run did before it answered — searches, documents, tool calls,
  // workflow steps and the answer's source — in the fields a live turn fills
  // from its stream (`shared/run/runActivity.js` builds both), so the reopened
  // answer shows how it came about the way it did while it streamed.
  if (msg.activity && typeof msg.activity === 'object') {
    for (const field of STORED_ACTIVITY_FIELDS) {
      if (msg.activity[field] !== undefined && msg.activity[field] !== null) {
        message[field] = msg.activity[field];
      }
    }
  }
  if (Array.isArray(msg.artifacts) && msg.artifacts.length > 0) {
    message.artifacts = msg.artifacts;
    const images = msg.artifacts.filter(artifact => (artifact?.kind || 'image') === 'image');
    if (images.length > 0) message.images = images;
    // Files the turn's tools generated (a PDF from `create_pdf`) are stored as
    // `document` artifacts; they come back as the download cards a live turn
    // shows, fetched by artifact id like a stored picture.
    const generatedFiles = generatedFilesFromArtifacts(msg.artifacts);
    if (generatedFiles.length > 0) message.generatedFiles = generatedFiles;
  }
  if (msg.error) {
    // A stopped turn kept whatever it had already produced — that is a
    // cancelled message, not a failed one. `error` is only ever read as a
    // strict boolean (`ChatMessage.jsx`), so the stored `{ code, message }`
    // must not be handed through as-is.
    if (msg.error.code === 'ABORTED') {
      message.cancelled = true;
      if (msg.error.cause) message.abortCause = msg.error.cause;
    } else message.error = true;
    // The reason survives separately. A failed turn usually stored no content
    // at all, so without this the bubble has nothing to show and reads as an
    // answer the model never gave.
    if (typeof msg.error.message === 'string' && msg.error.message) {
      message.errorMessage = msg.error.message;
    }
    // Stored reasons are English; a known code lets the bubble translate it.
    if (typeof msg.error.code === 'string') message.errorCode = msg.error.code;
  }

  return message;
}

/**
 * Custom hook for managing chat messages.
 *
 * The server owns every transcript: a chat is stored whether it is kept in the
 * history or temporary, the transcript arrives by hydration, and a request
 * carries only the new message (a longer array is refused with
 * `CLIENT_HISTORY_NOT_ALLOWED`). Nothing is kept in browser storage.
 *
 * @param {string} chatId - The ID of the current chat
 * @param {Object} [options] - Additional options
 * @param {boolean} [options.hydrates=true] - Whether a chat has to be fetched
 *   from the store before it is known to be empty: `hydrating` stays true until
 *   `loadServerMessages` or `finishHydration` says so, after mount and after
 *   every switch to another chat. A surface that only ever opens new chats (the
 *   compare panels) passes false and is never hydrating.
 * @returns {Object} Chat message management functions and state
 */
function useChatMessages(chatId = 'default', { hydrates = true } = {}) {
  // Track the previous chatId to detect changes
  const prevChatIdRef = useRef(chatId);

  const [messages, setMessages] = useState([]);

  // True while the stored transcript is still on its way. Callers need it to
  // hold back the greeting: an empty `messages` is indistinguishable from "not
  // fetched yet", so an async hydrate otherwise flashes the empty state and
  // the starter prompts for a paint before the history lands.
  const [hydrated, setHydrated] = useState(!hydrates);

  // The effect below resets `hydrated` — but an effect runs *after* the render
  // that triggered it has painted, so on the frame the chat switches
  // `hydrated` is still the previous chat's value and the surface renders one
  // settled, empty transcript. That single frame is the greeting flash
  // hydration exists to prevent, so the switch is read straight from the ref
  // here, in render, where it is already visible.
  const switchingChat = prevChatIdRef.current !== chatId;
  const hydrating = hydrates && (!hydrated || switchingChat);

  /**
   * Mark hydration finished without replacing anything: the chat has no stored
   * transcript yet, or the fetch failed and the caller has already reported it.
   */
  const finishHydration = useCallback(() => {
    setHydrated(true);
  }, []);

  // Another chat means another stored transcript to fetch.
  useEffect(() => {
    if (prevChatIdRef.current !== chatId && prevChatIdRef.current !== null) {
      debugLog('[useChatMessages] ChatId changed from', prevChatIdRef.current, 'to', chatId);
      setMessages([]);
      if (hydrates) setHydrated(false);
    }
    prevChatIdRef.current = chatId;
  }, [chatId, hydrates]);

  // Use a ref to store a copy of messages for read-only operations
  const messagesRef = useRef(messages);

  // Update the ref whenever state changes
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /**
   * Add a user message to the chat
   * @param {string} content - The content of the message
   * @param {Object} metadata - Additional metadata for the message
   * @returns {string} The ID of the created message
   */
  const addUserMessage = useCallback((content, metadata = {}) => {
    const { rawContent, imageData, fileData, audioData, ...rest } = metadata;
    const id = `user-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const userMessage = {
      id,
      role: 'user',
      content,
      imageData,
      fileData,
      audioData,
      ...rest
    };

    if (rawContent !== undefined) {
      userMessage.rawContent = rawContent;
    }

    setMessages(prev => [...prev, userMessage]);
    return id;
  }, []);

  /**
   * Add a placeholder for an assistant message
   * @param {string} exchangeId - Optional ID to use for the message
   * @returns {string} The ID of the created message
   */
  const addAssistantMessage = useCallback((exchangeId = null) => {
    const id = exchangeId || `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    setMessages(prev => [
      ...prev,
      {
        id,
        role: 'assistant',
        content: '',
        loading: true
      }
    ]);

    return id;
  }, []);

  /**
   * Update an assistant message with new content
   * @param {string} id - The ID of the message to update
   * @param {string} content - The new content
   * @param {boolean} isLoading - Whether the message is still loading
   */
  const updateAssistantMessage = useCallback((id, content, isLoading = true, extra = {}) => {
    if (isLoading === false) {
      debugLog('✅ Setting message to completed state:', {
        id,
        contentLength: content?.length || 0,
        hasImages: !!extra.images,
        imageCount: extra.images?.length || 0
      });
    }

    setMessages(prev => {
      const currentMsg = prev.find(m => m.id === id);
      const updatedMessages = prev.map(msg =>
        msg.id === id
          ? {
              ...msg,
              content,
              loading: isLoading,
              ...extra,
              _timestamp: Date.now(), // Add timestamp to force new object reference
              _contentLength: content.length // Track content length to ensure React detects changes
            }
          : msg
      );

      // Debug logging to track image persistence
      const updatedMsg = updatedMessages.find(m => m.id === id);
      if (currentMsg?.images || extra.images || updatedMsg?.images) {
        debugLog('🖼️ Image update for message', id, ':', {
          previousImages: currentMsg?.images?.length || 0,
          extraImages: extra.images?.length || 0,
          resultImages: updatedMsg?.images?.length || 0,
          isLoading
        });
      }

      return updatedMessages;
    });
  }, []);

  /**
   * Append text to an assistant message's content using a functional state
   * update, guaranteeing the suffix lands on the LATEST content even if more
   * chunks arrived between the caller's read of `messagesRef` and this write.
   * Used by cancellation so an in-flight chunk never gets overwritten by a
   * stale-snapshot-based concat.
   *
   * @param {string} id - The message id
   * @param {string} suffix - Text to append (the caller is responsible for any leading separator)
   * @param {Object} [extra] - Extra fields to merge (e.g. `loading: false`)
   */
  const appendToAssistantMessage = useCallback((id, suffix, extra = {}) => {
    setMessages(prev =>
      prev.map(msg =>
        msg.id === id
          ? {
              ...msg,
              content: (msg.content || '') + suffix,
              ...extra,
              _timestamp: Date.now(),
              _contentLength: ((msg.content || '') + suffix).length
            }
          : msg
      )
    );
  }, []);

  /**
   * Append (or update) a workflow step on a message using a functional
   * state update.
   *
   * The previous implementation read `prevSteps` from a ref and passed
   * `[...prevSteps, newStep]` into `updateAssistantMessage`. When multiple
   * step events fire within the same React render tick (e.g. an executor
   * emits ten "Skipped (already searched): …" events back-to-back), every
   * event after the first sees the same stale snapshot and overwrites the
   * prior accumulation — dropping steps silently. Moving the merge inside
   * `setMessages(prev => …)` guarantees each event reads the latest live
   * state, so no step is lost regardless of how fast they arrive.
   *
   * Semantics match the old in-line handler:
   *   - status:'running'   → mark any other running step as completed, append new
   *   - status:'completed'/'error' → if a step with the same nodeName exists,
   *                                  replace it; otherwise append.
   *
   * @param {string} id - Message id to mutate
   * @param {Object} step - The step to append/update (nodeName, status, etc.)
   * @param {Object} [extra] - Additional message fields to merge (e.g. workflowStep)
   */
  const appendWorkflowStep = useCallback((id, step, extra = {}) => {
    setMessages(prev =>
      prev.map(msg => {
        if (msg.id !== id) return msg;
        const prevSteps = msg.workflowSteps || [];
        let updatedSteps;
        if (step?.status === 'running') {
          updatedSteps = prevSteps.map(s =>
            s.status === 'running' ? { ...s, status: 'completed' } : s
          );
          updatedSteps = [...updatedSteps, step];
        } else {
          const exists = prevSteps.some(s => s.nodeName === step.nodeName);
          updatedSteps = exists
            ? prevSteps.map(s => (s.nodeName === step.nodeName ? step : s))
            : [...prevSteps, step];
        }
        return {
          ...msg,
          workflowSteps: updatedSteps,
          ...extra,
          _timestamp: Date.now()
        };
      })
    );
  }, []);

  /**
   * Set an error on a message
   * @param {string} id - The ID of the message to update
   * @param {string} errorMessage - The error message
   * @param {boolean} preserveContent - Whether to preserve existing content (default: true)
   */
  const setMessageError = useCallback((id, errorMessage, preserveContent = true) => {
    setMessages(prev =>
      prev.map(msg =>
        msg.id === id
          ? {
              ...msg,
              content:
                preserveContent && msg.content && !msg.content.includes(errorMessage)
                  ? `${msg.content}\n\n${errorMessage}`
                  : errorMessage,
              loading: false,
              error: true
            }
          : msg
      )
    );
  }, []);

  /**
   * Delete a message and all subsequent messages
   * @param {string} messageId - The ID of the message to delete
   */
  const deleteMessage = useCallback(messageId => {
    // Using messagesRef instead of messages dependency
    const messageIndex = messagesRef.current.findIndex(msg => msg.id === messageId);
    if (messageIndex !== -1) {
      const newMessages = messagesRef.current.slice(0, messageIndex);
      setMessages(newMessages);
    }
  }, []); // No dependency on messages anymore

  /**
   * Remove one message, leaving the ones after it in place. Unlike
   * `deleteMessage` this reads the latest state, so it also removes a message
   * added in the same tick.
   * @param {string} messageId - The ID of the message to remove
   */
  const removeMessage = useCallback(messageId => {
    setMessages(prev => prev.filter(message => message.id !== messageId));
  }, []);

  /**
   * Edit a message's content
   * @param {string} messageId - The ID of the message to edit
   * @param {string} newContent - The new content for the message
   */
  const editMessage = useCallback((messageId, newContent) => {
    setMessages(prev =>
      prev.map(message =>
        message.id === messageId
          ? { ...message, content: newContent, rawContent: newContent }
          : message
      )
    );
  }, []);

  /**
   * Add a system message (for errors, notifications, etc.)
   * @param {string} content - The content of the system message
   * @param {boolean} isError - Whether this is an error message
   * @returns {string} The ID of the created message
   */
  const addSystemMessage = useCallback((content, isError = false) => {
    const id = `system-${Date.now()}`;

    setMessages(prev => [
      ...prev,
      {
        id,
        role: 'system',
        content,
        error: isError,
        isErrorMessage: isError
      }
    ]);

    return id;
  }, []);

  /**
   * Clear all messages
   */
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  /**
   * Replace the whole transcript with one loaded from the server, and end
   * hydration.
   *
   * @param {Array} serverMessages - The stored transcript (`GET /api/chats/:chatId`)
   * @param {Object} [options] - Load options.
   * @param {boolean} [options.preserveLocal] - Keep messages added while the fetch was in
   *   flight and put the loaded transcript in front of them, instead of replacing. A
   *   hydrate races the composer: the user (or an auto-send) can start a turn during the
   *   round trip, and replacing would silently drop that turn from the screen while the
   *   server keeps appending to it.
   * @returns {string|null} The last assistant message ID (for parent_id chaining)
   */
  const loadServerMessages = useCallback((serverMessages, { preserveLocal = false } = {}) => {
    setHydrated(true);
    if (!serverMessages || serverMessages.length === 0) return null;

    let lastAssistantId = null;
    const transformed = serverMessages.map(msg => {
      const message = transformStoredMessage(msg);

      if (message.role === 'assistant') {
        lastAssistantId = message.id;
      }

      return message;
    });

    setMessages(prev => {
      if (!preserveLocal || prev.length === 0) return transformed;
      const loaded = new Set(transformed.map(message => message.id));
      return [...transformed, ...prev.filter(message => !loaded.has(message.id))];
    });
    return lastAssistantId;
  }, []);

  /**
   * The request body's `messages` for a turn: exactly the new message. The
   * server reads the rest of the conversation out of the store.
   *
   * @param {Object} newMessage - The message being sent
   * @returns {Array} A one-element array, formatted for the API
   */
  const getMessagesForApi = useCallback(newMessage => {
    if (!newMessage) return [];
    // Strip UI-specific properties that the API doesn't need. MCP App views
    // carry their full tool payload and must not ride along.
    const {
      rawContent,
      mcpApps: _mcpApps,
      mcpAuthRequired: _mcpAuthRequired,
      scheduledTaskProposals: _scheduledTaskProposals,
      generatedFiles: _generatedFiles,
      ...apiMsg
    } = newMessage;
    const content = rawContent !== undefined ? rawContent : apiMsg.content;
    return [{ ...apiMsg, content }];
  }, []);

  return {
    messages,
    messagesRef,
    hydrating,
    finishHydration,
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    appendToAssistantMessage,
    appendWorkflowStep,
    setMessageError,
    deleteMessage,
    removeMessage,
    editMessage,
    addSystemMessage,
    clearMessages,
    getMessagesForApi,
    loadServerMessages
  };
}

export default useChatMessages;
