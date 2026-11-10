// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import ChatMessage from './ChatMessage';
import RunAnnouncer from './RunAnnouncer';
import Icon from '../../../shared/components/Icon';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

/**
 * Whether a user message carries an upload: its attachment views (derived from the
 * payload for a turn sent in this session, from the stored descriptors otherwise).
 * The payload fields are still checked: a message built by a caller that did not
 * derive views must not lose its file-only turn.
 *
 * @param {Object} message - Chat message.
 * @returns {boolean}
 */
function hasUserAttachments(message) {
  return [message.attachments, message.fileData, message.imageData, message.audioData].some(
    value => (Array.isArray(value) ? value.length > 0 : !!value)
  );
}

/**
 * The messages of a chat as one `role="log"` region, with smart auto-scrolling
 * Auto-scrolls to new messages and during streaming unless user manually scrolls up
 * Only renders when there are actual messages to display
 */
function MessageLog({
  messages,
  outputFormat = 'markdown',
  onDelete,
  onEdit,
  onResend,
  appId,
  chatId,
  modelId,
  editable = false,
  compact = false,
  onOpenInCanvas,
  onInsert,
  insertAction = null,
  // Host answer actions for the Office task pane's split button — see ChatMessage.
  insertActions = null,
  defaultInsertActionId = null,
  onInsertAction = null,
  canvasEnabled = false,
  app = null, // App configuration for custom response rendering
  models = [], // Available models to pass to ChatMessage for link generation
  // Clarification handlers
  onClarificationSubmit = null, // Callback when a clarification response is submitted
  onClarificationSkip = null, // Callback when a clarification is skipped
  // Tool approval (#2945): `({ interactionId, decision, grant }) => void`. Without it a
  // card is shown read-only (the surface cannot answer it).
  onToolApproval = null,
  // Citation document action handlers
  onOpenSourceInApp = null,
  // Page a message's copy-link action points at — see ChatMessage.
  linkPath = null,
  // Off by default: a two-party chat needs no sender marks, and on a phone
  // or in a task pane they cost the answer 40-60 px of width.
  showAvatars = false,
  // A shared, read-only transcript — see ChatMessage.
  readOnly = false,
  // What MCP App views may do in the composer — see ChatMessage.
  mcpAppHost = null,
  // The chat's enabled tools, for a message's "Schedule this…" — see ChatMessage.
  scheduleEnabledTools = null,
  // The chat's integration scopes, for a message's "Schedule this…".
  scheduleIntegrationScopes = null,
  // "Save as prompt" on the user's messages — see ChatMessage.
  onSaveAsPrompt = null,
  // "Save as skill" on answers that draft a skill — see ChatMessage.
  onSaveAsSkill = null
}) {
  const { t } = useTranslation();
  const chatContainerRef = useRef(null);
  const { uiConfig } = useUIConfig();
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const shouldAutoScrollRef = useRef(shouldAutoScroll);
  shouldAutoScrollRef.current = shouldAutoScroll;
  const isUserScrollingRef = useRef(false);
  const prevMessageCountRef = useRef(0);

  // The scroll container renders only once there is a message, so it is
  // wired up in a callback ref rather than a mount effect, which would find no
  // container in a chat that starts empty.
  const observeContainer = useCallback(node => {
    chatContainerRef.current = node;
    if (!node) return undefined;

    // Detect manual scrolling by the user
    const handleScroll = () => {
      // Check if user is near the bottom (within 50px)
      const isNearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 50;

      // If user scrolls away from bottom, disable auto-scroll
      // If user scrolls back to bottom, re-enable auto-scroll
      if (!isUserScrollingRef.current) {
        isUserScrollingRef.current = true;
        setTimeout(() => {
          isUserScrollingRef.current = false;
        }, 100);
      }

      setShouldAutoScroll(isNearBottom);
    };
    node.addEventListener('scroll', handleScroll, { passive: true });

    // The list gets shorter when the composer below it grows — a one-line
    // composer does from the second line the user types (#3520). Scrolled to
    // the bottom, the user stays there, so the end of the answer they are
    // replying to stays in view.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (shouldAutoScrollRef.current) node.scrollTop = node.scrollHeight;
          });
    observer?.observe(node);

    return () => {
      node.removeEventListener('scroll', handleScroll);
      observer?.disconnect();
      chatContainerRef.current = null;
    };
  }, []);

  const assistantIcon = uiConfig?.icons?.assistantMessage || 'apps-svg-logo';
  const userIcon = uiConfig?.icons?.userMessage || 'user';
  const errorIcon = uiConfig?.icons?.errorMessage || 'exclamation-circle';

  // Always scroll to show user's new message, regardless of shouldAutoScroll
  // This ensures the user can see their input was sent
  useEffect(() => {
    if (!chatContainerRef.current || messages.length === 0) return;

    const container = chatContainerRef.current;
    const prevCount = prevMessageCountRef.current;
    const newMessagesCount = messages.length - prevCount;

    // Check if any of the newly added messages is a user message
    // (user message and assistant placeholder may be added together)
    const hasNewUserMessage =
      newMessagesCount > 0 && messages.slice(-newMessagesCount).some(msg => msg.role === 'user');

    // Always scroll when a new user message is added
    // Use requestAnimationFrame to ensure DOM has been updated with the new message
    if (hasNewUserMessage) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
      // Re-enable auto-scroll for the upcoming assistant response
      setShouldAutoScroll(true);
    }
    // For assistant messages (streaming), only scroll if shouldAutoScroll is true
    else if (shouldAutoScroll) {
      container.scrollTop = container.scrollHeight;
    }

    prevMessageCountRef.current = messages.length;
  }, [messages, shouldAutoScroll]);

  // Don't render anything if there are no messages
  if (messages.length === 0) {
    return null;
  }

  // Filter out empty user messages (used for auto-start feature). A turn that
  // only uploaded a file has no text either, but it is still the user's turn:
  // a reopened chat stores it as empty content plus attachment descriptors, and
  // hiding it left the answer standing without the question (issue #2601).
  const displayedMessages = messages.filter(
    message =>
      !(
        message.role === 'user' &&
        (!message.content || message.content.trim() === '') &&
        !hasUserAttachments(message)
      )
  );

  // Don't render anything if all messages were filtered out
  if (displayedMessages.length === 0) {
    return null;
  }

  // Index of the most recent assistant message. The Office insertAction
  // ('primary' variant) uses this to stay always-visible on the latest
  // response while older assistant turns fold back into hover-revealed icons,
  // so a small Outlook taskpane keeps a single dominant CTA in view.
  let lastAssistantIndex = -1;
  for (let i = displayedMessages.length - 1; i >= 0; i--) {
    if (displayedMessages[i].role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }

  return (
    <div
      ref={observeContainer}
      className="flex-1 mb-4 p-4 overflow-y-auto space-y-4 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      // A composer floating over the end of the list (FloatingComposer) sets this on
      // the parent; 0 where there is none.
      style={{ paddingBottom: 'calc(1rem + var(--chat-composer-clearance, 0px))' }}
      role="log"
      aria-live="polite"
      aria-label={t('chat.messageList', 'Chat messages')}
      // F6 cycles sidebar → chat log → composer → workspace pane.
      data-f6-region="chatlog"
      tabIndex={-1}
    >
      {displayedMessages.map((message, index) => (
        // One reading column, about 70 characters per line, centred; the
        // composer uses the same width (AppChat).
        <div
          key={message.id}
          data-message-role={message.role}
          data-message-id={message.id}
          className="w-full max-w-3xl mx-auto rounded-lg motion-safe:transition-colors"
        >
          <div
            className={`flex ${showAvatars ? 'gap-3' : 'gap-1'} ${message.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
          >
            {/* Message sender icon */}
            {showAvatars && (
              <div className="shrink-0 mt-1">
                {message.role === 'assistant' ? (
                  <Icon name={assistantIcon} size="2xl" className="text-blue-500" />
                ) : message.role === 'user' ? (
                  <Icon name={userIcon} size="xl" className="text-gray-500" />
                ) : (
                  <Icon name={errorIcon} size="2xl" className="text-yellow-500" />
                )}
              </div>
            )}

            {/* Message content */}
            {/* The answer takes the column; the user's bubble at most 85% of it. */}
            <div className={message.role === 'user' ? 'max-w-[85%]' : 'min-w-0 flex-1'}>
              <ChatMessage
                message={message}
                outputFormat={outputFormat}
                onDelete={onDelete}
                onEdit={onEdit}
                onResend={onResend}
                editable={editable}
                readOnly={readOnly}
                appId={appId}
                chatId={chatId}
                modelId={modelId}
                compact={compact}
                onOpenInCanvas={onOpenInCanvas}
                onInsert={onInsert}
                insertAction={insertAction}
                insertActions={insertActions}
                defaultInsertActionId={defaultInsertActionId}
                onInsertAction={onInsertAction}
                isLatestAssistantMessage={index === lastAssistantIndex}
                canvasEnabled={canvasEnabled}
                app={app}
                models={models}
                onClarificationSubmit={onClarificationSubmit}
                onClarificationSkip={onClarificationSkip}
                onToolApproval={onToolApproval}
                onOpenSourceInApp={onOpenSourceInApp}
                linkPath={linkPath}
                mcpAppHost={mcpAppHost}
                scheduleEnabledTools={scheduleEnabledTools}
                scheduleIntegrationScopes={scheduleIntegrationScopes}
                onSaveAsPrompt={onSaveAsPrompt}
                onSaveAsSkill={onSaveAsSkill}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A reusable component to display chat messages: the log, and beside it the
 * announcer that tells a screen reader what the turn is doing (#3534). The
 * announcer is a sibling of the log, not inside it: the activity list in the
 * log is silent, because a clock inside a live region is read every second,
 * and a live region inside another one is read as part of it. Every host (chat
 * page, embed, Office pane) gets both.
 *
 * @param {Object} props - see `MessageLog`; `messages` is also what the announcer follows
 * @param {string} [props.announceLabel] - said before each announcement, for a
 *   list that is shown beside others (compare mode), so a screen reader says which one
 */
function ChatMessageList({ announceLabel, ...props }) {
  return (
    <>
      <MessageLog {...props} />
      <RunAnnouncer messages={props.messages} label={announceLabel} />
    </>
  );
}

export default ChatMessageList;
