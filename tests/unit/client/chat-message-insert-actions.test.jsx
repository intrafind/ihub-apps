import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';

/**
 * The split button under an assistant answer in the Office task pane.
 *
 * Issue #2446: the pane used to render three buttons over two handlers — "Add
 * to email" and "Reply to email" both opened a reply-to-sender form, so testers
 * concluded the distinction was meaningless. ChatMessage now takes the host's
 * action list and reports back which one was chosen, so the surface can no
 * longer collapse two labels onto one behaviour. What is pinned here is the
 * wiring: the main button runs the resolved default, every menu entry reports
 * its own id, and hosts that supply no list keep the single-action button.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback || _key, i18n: { language: 'en' } })
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { featuresMap: {} } })
}));

jest.mock('../../../client/src/api', () => ({
  sendMessageFeedback: jest.fn(),
  answerInteraction: jest.fn()
}));

jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: ({ content }) => <div data-testid="content">{content}</div>
}));

jest.mock('../../../client/src/shared/components/CustomResponseRenderer', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: { get: jest.fn(), post: jest.fn() },
  default: { get: jest.fn(), post: jest.fn() }
}));

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`,
  buildAssetUrl: path => path,
  buildPath: path => path
}));

const assistantMessage = {
  id: 'msg-1',
  role: 'assistant',
  content: 'Sounds good to me.'
};

/** What the Outlook pane passes while an email is selected in the reading pane. */
const READ_MODE_ACTIONS = [
  { id: 'answerAll', label: 'Reply all', icon: 'users' },
  { id: 'answer', label: 'Reply', icon: 'undo' },
  { id: 'forward', label: 'Forward', icon: 'redo' },
  { id: 'new', label: 'New email', icon: 'pencil' }
];

function renderMessage(props = {}) {
  return render(
    <ChatMessage
      message={assistantMessage}
      appId="chat"
      chatId="chat-1"
      modelId="m"
      insertAction={{ variant: 'primary', labelKey: 'office.insertIntoEmail' }}
      {...props}
    />
  );
}

test('the main button runs the resolved default action', () => {
  const onInsertAction = jest.fn();
  renderMessage({
    insertActions: READ_MODE_ACTIONS,
    defaultInsertActionId: 'answerAll',
    onInsertAction
  });

  fireEvent.click(screen.getByRole('button', { name: 'Reply all' }));

  expect(onInsertAction).toHaveBeenCalledWith('answerAll', 'Sounds good to me.');
});

test('the main button follows the configured default, not the list order', () => {
  const onInsertAction = jest.fn();
  renderMessage({
    insertActions: READ_MODE_ACTIONS,
    defaultInsertActionId: 'forward',
    onInsertAction
  });

  fireEvent.click(screen.getByRole('button', { name: 'Forward' }));

  expect(onInsertAction).toHaveBeenCalledWith('forward', 'Sounds good to me.');
});

test('every menu entry reports its own action — no two share a handler', () => {
  const onInsertAction = jest.fn();
  renderMessage({
    insertActions: READ_MODE_ACTIONS,
    defaultInsertActionId: 'answerAll',
    onInsertAction
  });

  for (const { id, label } of READ_MODE_ACTIONS) {
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}$`) }));
    expect(onInsertAction).toHaveBeenLastCalledWith(id, 'Sounds good to me.');
  }

  expect(onInsertAction).toHaveBeenCalledTimes(READ_MODE_ACTIONS.length);
  expect(new Set(onInsertAction.mock.calls.map(([id]) => id)).size).toBe(READ_MODE_ACTIONS.length);
});

test('a single-action host gets no menu — compose mode only offers Insert', () => {
  const onInsertAction = jest.fn();
  renderMessage({
    insertActions: [{ id: 'insert', label: 'Insert into draft', icon: 'arrow-right' }],
    defaultInsertActionId: 'insert',
    onInsertAction
  });

  expect(screen.queryByRole('button', { name: 'More options' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Insert into draft' }));
  expect(onInsertAction).toHaveBeenCalledWith('insert', 'Sounds good to me.');
});

test('a host with no action list keeps the single insert button', () => {
  const onInsert = jest.fn();
  renderMessage({ onInsert });

  expect(screen.queryByRole('button', { name: 'More options' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Add to email' }));
  expect(onInsert).toHaveBeenCalledWith('Sounds good to me.');
});
