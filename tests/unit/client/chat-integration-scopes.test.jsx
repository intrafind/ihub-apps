// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * Integration scopes in the chat input (intrafind/ihub-apps#3050): the "+"
 * menu row that shows where an integration searches and opens a submenu to
 * change it. It is driven by the integrations the server lists, so nothing
 * here names iFinder.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => defaultValue || key,
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
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

const SEARCH = {
  id: 'ifinder',
  name: { en: 'iFinder', de: 'iFinder' },
  action: 'search',
  scopePicker: 'menu',
  fixed: false,
  defaultScope: 'standard',
  current: 'contracts',
  scopes: [
    { id: 'standard', name: 'Standard', isDefault: true },
    { id: 'contracts', name: 'Contracts', isDefault: false }
  ]
};

function openMenu(integration = SEARCH) {
  const onIntegrationScopeChange = jest.fn();
  render(
    <ChatInputActionsMenu
      app={{ id: 'demo' }}
      enabledTools={null}
      uploadConfig={{}}
      integrationScopes={[integration]}
      onIntegrationScopeChange={onIntegrationScopeChange}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Actions menu' }));
  return { onIntegrationScopeChange };
}

describe('integration scopes in the "+" menu', () => {
  it('shows the scope in use and opens a submenu of radio items', () => {
    const { onIntegrationScopeChange } = openMenu();

    const row = screen.getByRole('menuitem', { name: /iFinder/ });
    expect(row).toHaveTextContent('Search in: Contracts');
    expect(row).toHaveAttribute('aria-haspopup', 'menu');
    expect(row).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Contracts' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Standard' }), { key: ' ' });
    expect(onIntegrationScopeChange).toHaveBeenCalledWith('ifinder', 'standard');
  });

  it('closes the whole menu once a scope is picked', () => {
    const { onIntegrationScopeChange } = openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /iFinder/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Standard' }));

    expect(onIntegrationScopeChange).toHaveBeenCalledWith('ifinder', 'standard');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions menu' })).toHaveFocus();
  });

  it('shows a hint when only the default could be offered', () => {
    openMenu({ ...SEARCH, hint: 'forbidden', current: 'standard', scopes: [SEARCH.scopes[0]] });
    expect(screen.getByText(/only the default is offered/)).toBeInTheDocument();
  });

  it('offers no submenu for a fixed scope', () => {
    openMenu({ ...SEARCH, fixed: true, current: 'standard', scopes: [SEARCH.scopes[0]] });
    const row = screen.getByRole('menuitem', { name: /iFinder/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveTextContent('Set by the app');
    fireEvent.click(row);
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
  });

  it('leaves out an integration whose picker is hidden', () => {
    render(
      <ChatInputActionsMenu
        app={{ id: 'demo', websearch: { enabled: true } }}
        enabledTools={null}
        uploadConfig={{}}
        onWebsearchEnabledChange={jest.fn()}
        integrationScopes={[{ ...SEARCH, scopePicker: 'hidden' }]}
        onIntegrationScopeChange={jest.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions menu' }));
    expect(screen.queryByText('Use in this chat')).not.toBeInTheDocument();
  });
});
