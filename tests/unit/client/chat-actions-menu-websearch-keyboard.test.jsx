import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * Web Search toggle keyboard activation (intrafind/ihub-apps#1295).
 *
 * The `+` actions menu renders its tool rows as `menuitemcheckbox` elements
 * that take part in the menu's roving tabindex and toggle on Space. The Web
 * Search row was built from a bare `<div>` wrapping a visually hidden
 * checkbox, so keyboard users could tab into the menu but never activate it —
 * a WCAG 2.1.1 (Keyboard) failure. These tests pin the accessible contract of
 * that row.
 *
 * jsdom reports every element as zero-sized, so `useKeyboardNavigation`'s
 * visibility filter finds no items and its own Enter/Space handling never
 * runs here. That is deliberate: the assertions below cover the row's own
 * handlers and its registration in the roving-tabindex order, which is what
 * the fix adds.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => defaultValue || key,
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
  fetchToolsBasic: jest.fn(() => Promise.resolve([]))
}));

jest.mock('../../../client/src/utils/toolUsageTracker', () => ({
  trackToolUsage: jest.fn()
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({
    platformConfig: { cloudStorage: { enabled: false, providers: [] } }
  })
}));

jest.mock('../../../client/src/features/office/contexts/EmbeddedHostContext', () => ({
  useEmbeddedHost: () => null
}));

const ChatInputActionsMenu =
  require('../../../client/src/features/chat/components/ChatInputActionsMenu').default;

function openMenu(props = {}) {
  const onWebsearchEnabledChange = jest.fn();
  const utils = render(
    <ChatInputActionsMenu
      app={{ id: 'demo', websearch: { enabled: true } }}
      enabledTools={null}
      uploadConfig={{}}
      websearchEnabled={false}
      onWebsearchEnabledChange={onWebsearchEnabledChange}
      {...props}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Actions menu' }));
  return { ...utils, onWebsearchEnabledChange };
}

describe('ChatInputActionsMenu web search toggle', () => {
  it('exposes the row as a menuitemcheckbox carrying the toggle state', () => {
    openMenu();

    const row = screen.getByRole('menuitemcheckbox', { name: /Web Search/ });
    expect(row).toHaveAttribute('aria-checked', 'false');
  });

  it('reflects the enabled state through aria-checked', () => {
    openMenu({ websearchEnabled: true });

    expect(screen.getByRole('menuitemcheckbox', { name: /Web Search/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('activates on Space', () => {
    const { onWebsearchEnabledChange } = openMenu();

    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Web Search/ }), { key: ' ' });

    expect(onWebsearchEnabledChange).toHaveBeenCalledTimes(1);
    expect(onWebsearchEnabledChange).toHaveBeenCalledWith(true);
  });

  it('activates on Enter', () => {
    const { onWebsearchEnabledChange } = openMenu({ websearchEnabled: true });

    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /Web Search/ }), {
      key: 'Enter'
    });

    expect(onWebsearchEnabledChange).toHaveBeenCalledTimes(1);
    expect(onWebsearchEnabledChange).toHaveBeenCalledWith(false);
  });

  it('still toggles exactly once on click', () => {
    const { onWebsearchEnabledChange } = openMenu();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Web Search/ }));

    expect(onWebsearchEnabledChange).toHaveBeenCalledTimes(1);
    expect(onWebsearchEnabledChange).toHaveBeenCalledWith(true);
  });

  it('takes part in the menu roving tabindex', () => {
    openMenu();

    // Sole navigable item in this configuration, so it owns tabindex 0.
    expect(screen.getByRole('menuitemcheckbox', { name: /Web Search/ })).toHaveAttribute(
      'tabindex',
      '0'
    );
  });

  it('keeps the visual switch out of the accessibility tree and the tab order', () => {
    const { container } = openMenu();

    const input = container.querySelector('input[type="checkbox"]');
    expect(input).toHaveAttribute('aria-hidden', 'true');
    expect(input).toHaveAttribute('tabindex', '-1');
  });
});
