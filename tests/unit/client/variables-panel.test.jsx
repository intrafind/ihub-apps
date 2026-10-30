import '@testing-library/jest-dom';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

/**
 * The input parameters panel beside the chat (issue #3053): collapsed,
 * expanded and pinned by the user, with the app's `variablesPanel.pinned`
 * as the default. Unpinned, it collapses once a message is sent; pinned, it
 * stays open. A new chat opens it again.
 */

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, def) => (typeof def === 'string' ? def : key),
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const VariablesPanel =
  require('../../../client/src/features/chat/components/VariablesPanel').default;
const {
  default: useVariablesPanel,
  isVariablesPanelPinnedByDefault
} = require('../../../client/src/features/chat/hooks/useVariablesPanel');

const LOCALIZED = [{ name: 'tone', localizedLabel: 'Tone', type: 'string' }];

let sendRef;
function Harness({ app, chatId = 'c1' }) {
  const panel = useVariablesPanel({ app, appId: app.id, chatId });
  const [variables, setVariables] = useState({ tone: 'formal' });
  sendRef = panel.collapseAfterSend;
  return (
    <VariablesPanel
      variables={variables}
      setVariables={setVariables}
      localizedVariables={LOCALIZED}
      collapsed={panel.collapsed}
      pinned={panel.pinned}
      onToggleCollapsed={panel.toggleCollapsed}
      onTogglePinned={panel.togglePinned}
    />
  );
}

const field = () => screen.queryByDisplayValue('formal');
const send = () => act(() => sendRef());

beforeEach(() => window.localStorage.clear());

test('pinned unless the app says otherwise', () => {
  expect(isVariablesPanelPinnedByDefault({})).toBe(true);
  expect(isVariablesPanelPinnedByDefault({ variablesPanel: { pinned: true } })).toBe(true);
  expect(isVariablesPanelPinnedByDefault({ variablesPanel: { pinned: false } })).toBe(false);
});

test('pinned: stays open after a message is sent', () => {
  render(<Harness app={{ id: 'a' }} />);
  expect(field()).toBeInTheDocument();
  send();
  expect(field()).toBeInTheDocument();
});

test('unpinned: starts open, collapses on send, expands on demand, collapses again', () => {
  render(<Harness app={{ id: 'a', variablesPanel: { pinned: false } }} />);
  expect(field()).toBeInTheDocument();
  send();
  expect(field()).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show input parameters' }));
  expect(field()).toBeInTheDocument();
  send();
  expect(field()).not.toBeInTheDocument();
});

test('the user pins and unpins it, remembered per app', () => {
  const { unmount } = render(<Harness app={{ id: 'a', variablesPanel: { pinned: false } }} />);
  const pin = screen.getByRole('button', { name: 'Pin: keep the input parameters open' });
  expect(pin).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(pin);
  send();
  expect(field()).toBeInTheDocument();
  unmount();

  render(<Harness app={{ id: 'a', variablesPanel: { pinned: false } }} />);
  const unpin = screen.getByRole('button', {
    name: 'Unpin: hide the input parameters after each message'
  });
  expect(unpin).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(unpin);
  send();
  expect(field()).not.toBeInTheDocument();
});

test('collapsed by hand, and a new chat opens it again', () => {
  const app = { id: 'a' };
  const { rerender } = render(<Harness app={app} />);
  fireEvent.click(screen.getByRole('button', { name: 'Hide input parameters' }));
  expect(field()).not.toBeInTheDocument();
  rerender(<Harness app={app} chatId="c2" />);
  expect(field()).toBeInTheDocument();
});
