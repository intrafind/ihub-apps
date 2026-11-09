// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Issue #3520: the composer under the transcript grows from one line as the
 * user types, which makes the list above it shorter. A user scrolled to the end
 * stays there, so the answer being replied to stays in view; a user who
 * scrolled up to read something is left where they are.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessageList from '../../../client/src/features/chat/components/ChatMessageList';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback || _key, i18n: { language: 'en' } })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {} })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/ChatMessage', () => ({
  __esModule: true,
  default: ({ message }) => <div>{message.content}</div>
}));

const messages = [
  { id: 'u1', role: 'user', content: 'Summarise the contract' },
  { id: 'a1', role: 'assistant', content: 'The contract runs for two years.' }
];

let resizeCallbacks;
beforeEach(() => {
  resizeCallbacks = [];
  global.ResizeObserver = class {
    constructor(callback) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    disconnect() {}
  };
  // The list scrolls to the end on new messages in an animation frame.
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
    cb();
    return 0;
  });
});
afterEach(() => {
  delete global.ResizeObserver;
  jest.restoreAllMocks();
});

/** A scroll container 400px tall holding 1000px of transcript. */
const layOut = list => {
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
};
const resize = () => act(() => resizeCallbacks.forEach(callback => callback([])));

test('scrolled to the end, the list stays there when it gets shorter', () => {
  render(<ChatMessageList messages={messages} />);
  const list = screen.getByRole('log');
  layOut(list);
  list.scrollTop = 600;

  // The composer grew by two lines: the end of the answer is now below the fold.
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 352 });
  list.scrollTop = 600;
  resize();

  expect(list.scrollTop).toBe(1000);
});

test('scrolled up to read, the list is left where the user put it', () => {
  render(<ChatMessageList messages={messages} />);
  const list = screen.getByRole('log');
  layOut(list);
  list.scrollTop = 100;
  fireEvent.scroll(list);

  resize();

  expect(list.scrollTop).toBe(100);
});

test('a chat that starts empty is wired up once its first message arrives', () => {
  const { rerender } = render(<ChatMessageList messages={[]} />);
  expect(screen.queryByRole('log')).not.toBeInTheDocument();
  expect(resizeCallbacks).toHaveLength(0);

  rerender(<ChatMessageList messages={messages} />);
  const list = screen.getByRole('log');
  layOut(list);
  list.scrollTop = 100;
  fireEvent.scroll(list);
  resize();

  // The scroll listener is attached too: the user scrolled up and stays there.
  expect(resizeCallbacks).toHaveLength(1);
  expect(list.scrollTop).toBe(100);
});
