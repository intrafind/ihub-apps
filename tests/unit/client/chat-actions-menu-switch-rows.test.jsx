// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * On/off rows of the `+` actions menu (intrafind/ihub-apps#2925).
 *
 * The embedded host's message-context toggles are `menuitemcheckbox` items
 * of the `role="menu"`, like the integration rows of the picker (#2923,
 * `integration-picker.test.jsx`). The switch drawn in each
 * row is the shared `SwitchIndicator` (visual only): a checkbox or switch
 * inside a menu item would be a nested interactive control, and a bare
 * checkbox in a menu is not reachable with the arrow keys. These tests pin
 * that each row toggles exactly once on click, on Space (and Enter for the
 * context rows), and carries its state in `aria-checked`.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`}>{name}</span>;
  };
});

jest.mock('../../../client/src/shared/components/MagicPromptLoader', () => {
  return function MagicPromptLoader() {
    return <span>loading</span>;
  };
});

jest.mock('../../../client/src/features/chat/components/ImageGenerationControls', () => {
  return function ImageGenerationControls() {
    return <div />;
  };
});

jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: function VoiceInputComponent() {
    return <button type="button">voice</button>;
  }
}));

jest.mock('../../../client/src/api', () => ({
  saveIntegrationPreferences: jest.fn()
}));

let mockEmbeddedHost = null;
jest.mock('../../../client/src/features/office/contexts/EmbeddedHostContext', () => ({
  useEmbeddedHost: () => mockEmbeddedHost
}));

const ChatInputActionsMenu =
  require('../../../client/src/features/chat/components/ChatInputActionsMenu').default;

/**
 * Asserts that a row draws the shared SwitchIndicator in `state`, hidden from
 * assistive technology, and holds no other control.
 *
 * @param {HTMLElement} row - The menuitemcheckbox row.
 * @param {'on'|'off'} state - The drawn state.
 */
function expectVisualOnlySwitch(row, state) {
  const indicator = row.querySelector('[data-state]');
  expect(indicator).toHaveAttribute('aria-hidden', 'true');
  expect(indicator).toHaveAttribute('data-state', state);
  expect(row.querySelector('input, button, [role="switch"]')).toBeNull();
}

describe('ChatInputActionsMenu message-context rows', () => {
  beforeEach(() => {
    mockEmbeddedHost = {
      contextToggles: [
        {
          key: 'includePage',
          label: 'Include page',
          description: 'Send the open page with the message',
          defaultEnabled: true
        },
        { key: 'includeSelection', label: 'Include selection', defaultEnabled: false }
      ]
    };
  });

  function openContextMenu(flags = null) {
    const onHostContextFlagChange = jest.fn();
    render(
      <ChatInputActionsMenu
        app={{ id: 'demo' }}
        enabledTools={null}
        uploadConfig={{}}
        hostContextFlags={flags}
        onHostContextFlagChange={onHostContextFlagChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions menu' }));
    return { onHostContextFlagChange };
  }

  it('renders each toggle as a menuitemcheckbox the menu navigation can focus', () => {
    openContextMenu({ includeSelection: true });

    const menu = screen.getByRole('menu');
    const page = within(menu).getByRole('menuitemcheckbox', { name: /Include page/ });
    const selection = within(menu).getByRole('menuitemcheckbox', { name: /Include selection/ });

    // `defaultEnabled` applies without a stored flag; a stored flag wins.
    expect(page).toHaveAttribute('aria-checked', 'true');
    expect(selection).toHaveAttribute('aria-checked', 'true');
    expectVisualOnlySwitch(page, 'on');
    // Focusable by script like the picker's rows; `useKeyboardNavigation`
    // hands the active item tabindex 0 (jsdom reports no layout, so it stays idle).
    expect(page).toHaveAttribute('tabindex', '-1');
    page.focus();
    expect(page).toHaveFocus();
  });

  it('flips the flag once on click, Space and Enter', () => {
    const { onHostContextFlagChange } = openContextMenu();
    const page = screen.getByRole('menuitemcheckbox', { name: /Include page/ });
    const selection = screen.getByRole('menuitemcheckbox', { name: /Include selection/ });

    fireEvent.click(page);
    expect(onHostContextFlagChange).toHaveBeenLastCalledWith('includePage', false);

    fireEvent.keyDown(selection, { key: ' ' });
    expect(onHostContextFlagChange).toHaveBeenLastCalledWith('includeSelection', true);

    fireEvent.keyDown(selection, { key: 'Enter' });
    expect(onHostContextFlagChange).toHaveBeenCalledTimes(3);
  });
});
