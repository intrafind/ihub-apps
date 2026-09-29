import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatMessage from '../../../client/src/features/chat/components/ChatMessage';

/**
 * Regression test for https://github.com/intrafind/ihub-apps/issues/2594:
 * in Outlook the inline "edit message" textarea stuck out of the message bubble.
 *
 * Root cause: `.chat-widget-message-content` (the bubble) is
 * `box-sizing: content-box`, and the embedded entry stylesheets
 * (client/office, client/extension, client/nextcloud) reset every element to
 * `box-sizing: inherit` — unlayered, so it beats Tailwind's layered preflight
 * `border-box`. Everything inside the bubble therefore inherited `content-box`
 * and the `w-full` textarea (plus its padding and border) overflowed the bubble.
 *
 * jsdom does no layout and Jest maps CSS to identity-obj-proxy, so the visual
 * outcome cannot be asserted here. What is pinned instead are the two halves of
 * the fix that together produce it: the edit form carries the marker class, and
 * the stylesheet pins that class back to `border-box` in an *unlayered* rule
 * (a layered rule, such as Tailwind's `box-border`, would lose to the reset).
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

const CLIENT_DIR = path.resolve(__dirname, '../../../client');
const CHAT_MESSAGE_CSS = path.join(CLIENT_DIR, 'src/features/chat/components/ChatMessage.css');
const EMBED_ENTRY_CSS = ['office/office.css', 'extension/extension.css', 'nextcloud/nextcloud.css'];

const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

const userMessage = { id: 'msg-1', role: 'user', content: 'Finde meine vpn Vereinbarung' };

function renderInEditMode() {
  render(
    <ChatMessage
      message={userMessage}
      appId="chat"
      chatId="chat-1"
      modelId="m"
      compact={true}
      editable={true}
      onEdit={jest.fn()}
      onResend={jest.fn()}
    />
  );
  fireEvent.click(screen.getByTitle('Edit message'));
  return screen.getByRole('textbox', { name: 'Edit message' });
}

test('the edit form is marked so the stylesheet can pin its box-sizing', () => {
  const textarea = renderInEditMode();

  const form = textarea.closest('.chat-widget-message-edit');
  expect(form).not.toBeNull();
  // The whole form (textarea and the Cancel/Send row) lives under the marker,
  // and the marker sits inside the bubble it must not overflow.
  // (The mocked `t` echoes the key when a call has no fallback, so the buttons'
  // accessible names are the `common.cancel` / `common.send` keys.)
  expect(form).toContainElement(screen.getByRole('button', { name: 'common.cancel' }));
  expect(form).toContainElement(screen.getByRole('button', { name: 'common.send' }));
  expect(form.closest('.chat-widget-message-content')).not.toBeNull();
});

test('ChatMessage.css pins the edit form and everything in it to border-box, unlayered', () => {
  const css = stripComments(fs.readFileSync(CHAT_MESSAGE_CSS, 'utf8'));

  // Unlayered: an `@layer` rule loses to the embeds' unlayered `* { inherit }`.
  expect(css).not.toMatch(/@layer\b/);

  const rule = css.match(/(\.chat-widget-message-edit[^{}]*)\{([^{}]*)\}/);
  expect(rule).not.toBeNull();
  const [, selectors, declarations] = rule;
  // Covers the form itself and every descendant (textarea, buttons, icons).
  expect(selectors).toMatch(/\.chat-widget-message-edit\s*,/);
  expect(selectors).toMatch(/\.chat-widget-message-edit\s+\*\s*(,|$)/);
  expect(declarations).toMatch(/box-sizing\s*:\s*border-box/);
});

test.each(EMBED_ENTRY_CSS)(
  '%s still resets to box-sizing: inherit, which is why the pin above is needed',
  file => {
    // If an entry stops doing this, the pin is redundant but harmless — this
    // test then documents that it can be reconsidered rather than silently
    // rotting. It fails only when the reset is removed or changed.
    const css = stripComments(fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8'));
    expect(css).toMatch(/\*\s*,\s*\*::before\s*,\s*\*::after\s*\{[^}]*box-sizing\s*:\s*inherit/);
  }
);
