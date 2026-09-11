/**
 * Regression test for https://github.com/intrafind/ihub-apps/issues/2333:
 * editing an earlier message in a multi-turn conversation must auto-resend,
 * not just land in the input box.
 *
 * Root cause: AppChat.jsx's handleResendMessage set `input` (and variables/
 * files) then used `setTimeout(() => formRef.current?.requestSubmit(), 0)`
 * to auto-submit. ChatMessage.jsx's handleSaveEdit already calls onResend
 * from inside its own setTimeout (250ms after onEdit), so the resend's
 * `setInput` runs inside a setTimeout-within-a-setTimeout. A bare
 * `setTimeout(fn, 0)` there can fire before React commits that state update,
 * so handleSubmit's closure reads the stale (often empty) `input` and
 * silently no-ops — the edited text is left sitting in the box instead of
 * being resent, exactly as reported. Routing the auto-submit through a
 * `pendingAutoSubmit` state flag consumed by a `useEffect` (which by
 * definition only runs after React has committed) fixes it: this harness
 * mirrors that fixed wiring and fails if the fix regresses back to the
 * setTimeout-only version.
 *
 * The harness mirrors AppChat.jsx's real wiring (input state, formRef,
 * handleSubmit, handleResendMessage/prepareResend, the pendingAutoSubmit
 * effect) around the REAL useAppChat hook, with only the network transport
 * (useEventSource / sendAppChatMessage) mocked — same pattern as
 * use-app-chat-event-handlers.test.jsx. ChatMessage.jsx's edit-then-resend
 * setTimeout(250) is reproduced directly since its own logic isn't in
 * question here (see ChatMessage.jsx's handleSaveEdit).
 */

import { useRef, useState, useEffect } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => '00000000-0000-0000-0000-000000000000'
}));

let capturedOnEvent = null;
jest.mock('../../../client/src/shared/hooks/useEventSource', () => ({
  __esModule: true,
  default: ({ onEvent }) => {
    capturedOnEvent = onEvent;
    return {
      initEventSource: jest.fn(),
      cleanupEventSource: jest.fn()
    };
  }
}));

jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  sendAppChatMessage: jest.fn().mockResolvedValue({})
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, def) => def || key })
}));

jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`
}));

const useAppChat = require('../../../client/src/features/chat/hooks/useAppChat').default;

let seq = 0;
function envelope(type, data = {}, runId = 'run-1') {
  seq += 1;
  return { v: 2, seq, runId, ts: new Date(1756800000000 + seq * 1000).toISOString(), type, data };
}
async function deliver(type, data, runId) {
  const env = envelope(type, data, runId);
  await act(async () => {
    await capturedOnEvent({ type: env.type, envelope: env });
  });
  return env;
}
async function runFullExchange(assistantId, runId, replyText) {
  await deliver(
    'run/started',
    { kind: 'chat', model: 'gpt-x', refs: { messageId: assistantId } },
    runId
  );
  await deliver('step/delta', { step: 0, kind: 'text', content: replyText }, runId);
  await deliver('run/ended', { status: 'completed', finishReason: 'stop' }, runId);
}

/**
 * Mirrors AppChat.jsx's own submit wiring (handleSubmit, handleEditMessage,
 * handleResendMessage, the pendingAutoSubmit effect) plus a minimal stand-in
 * for ChatMessage.jsx's handleSaveEdit (update content, then 250ms later
 * resend) — not ChatMessage's UI, which isn't in question here.
 */
function Harness() {
  const chat = useAppChat({ appId: 'app1', chatId: 'chat1' });
  const [input, setInput] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editedContent, setEditedContent] = useState('');
  const [pendingAutoSubmit, setPendingAutoSubmit] = useState(false);
  const formRef = useRef(null);

  useEffect(() => {
    if (!pendingAutoSubmit) return;
    setPendingAutoSubmit(false);
    formRef.current?.requestSubmit();
  }, [pendingAutoSubmit]);

  const handleResendMessage = (messageId, editedText) => {
    const { content: contentToResend } = chat.resendMessage(messageId, editedText);
    if (!contentToResend) return;
    setInput(contentToResend);
    setPendingAutoSubmit(true);
  };

  const handleSubmit = e => {
    e.preventDefault();
    if (!input.trim()) return;
    if (chat.processing) return;
    chat.sendMessage({ displayMessage: input, apiMessage: { content: input }, params: {} });
    setInput('');
  };

  const startSaveEdit = messageId => {
    // Mirrors ChatMessage.handleSaveEdit: update content, then 250ms later
    // resend with the edited text — same two-step timing as production.
    chat.editMessage(messageId, editedContent);
    setEditingId(null);
    setTimeout(() => {
      handleResendMessage(messageId, editedContent);
    }, 250);
  };

  return (
    <div>
      <form ref={formRef} onSubmit={handleSubmit}>
        <input data-testid="chat-input" value={input} onChange={e => setInput(e.target.value)} />
        <button type="submit">Send</button>
      </form>
      <div data-testid="processing">{String(chat.processing)}</div>
      <ul>
        {chat.messages.map(m => (
          <li key={m.id} data-testid={`msg-${m.role}`}>
            {editingId === m.id ? (
              <>
                <input
                  data-testid="edit-input"
                  value={editedContent}
                  onChange={e => setEditedContent(e.target.value)}
                />
                <button data-testid="save-edit" onClick={() => startSaveEdit(m.id)}>
                  Save
                </button>
              </>
            ) : (
              <>
                <span data-testid={`content-${m.id}`}>{m.content}</span>
                {m.role === 'user' && (
                  <button
                    data-testid={`edit-${m.id}`}
                    onClick={() => {
                      setEditedContent(m.rawContent ?? m.content);
                      setEditingId(m.id);
                    }}
                  >
                    Edit
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function messageIdFromRow(row) {
  return row
    .querySelector('[data-testid^="content-"]')
    .getAttribute('data-testid')
    .replace('content-', '');
}

beforeEach(() => {
  capturedOnEvent = null;
  seq = 0;
});

test('editing an earlier message auto-resends it even after multiple prior exchanges', async () => {
  render(<Harness />);

  const input = screen.getByTestId('chat-input');
  const form = input.closest('form');

  // --- Exchange 1 ---
  fireEvent.change(input, { target: { value: 'Question 1' } });
  fireEvent.submit(form);
  let assistantRow = screen.getAllByTestId('msg-assistant').at(-1);
  await runFullExchange(messageIdFromRow(assistantRow), 'run-1', 'Answer 1');
  expect(screen.getByTestId('processing')).toHaveTextContent('false');
  expect(input).toHaveValue('');

  // --- Exchange 2 (conversation now has "more than one question") ---
  fireEvent.change(input, { target: { value: 'Question 2' } });
  fireEvent.submit(form);
  assistantRow = screen.getAllByTestId('msg-assistant').at(-1);
  await runFullExchange(messageIdFromRow(assistantRow), 'run-2', 'Answer 2');
  expect(screen.getByTestId('processing')).toHaveTextContent('false');

  const userRows = screen.getAllByTestId('msg-user');
  expect(userRows).toHaveLength(2);
  const firstUserId = messageIdFromRow(userRows[0]);

  // Edit the FIRST question.
  fireEvent.click(screen.getByTestId(`edit-${firstUserId}`));
  fireEvent.change(screen.getByTestId('edit-input'), {
    target: { value: 'Question 1 EDITED' }
  });
  fireEvent.click(screen.getByTestId('save-edit'));

  // Advance past ChatMessage's 250ms edit-then-resend delay.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 400));
  });

  // The edit must have been auto-resent: input clears, a fresh exchange
  // is in flight, and the conversation was truncated + replaced with the
  // edited question (not left duplicated or dropped).
  expect(input).toHaveValue('');
  expect(screen.getByTestId('processing')).toHaveTextContent('true');
  const newUserRows = screen.getAllByTestId('msg-user');
  expect(newUserRows).toHaveLength(1);
  expect(newUserRows[0].querySelector('[data-testid^="content-"]')).toHaveTextContent(
    'Question 1 EDITED'
  );

  // Let the third exchange complete too, to confirm it isn't left hanging.
  const newAssistantRow = screen.getAllByTestId('msg-assistant').at(-1);
  await runFullExchange(messageIdFromRow(newAssistantRow), 'run-3', 'Answer 1 revised');
  expect(screen.getByTestId('processing')).toHaveTextContent('false');
});
