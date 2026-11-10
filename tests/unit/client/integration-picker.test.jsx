// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The chat's integrations picker (intrafind/ihub-apps#2923): the "+" menu
 * lists one row per integration — from the server, never derived from tool
 * ids — with its effect summary, `Connect →` for a personal integration that
 * is not connected, and its scope; chips under the composer show what is on.
 * A switch changes this chat only; the default changes only when saved.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

jest.mock('../../../client/src/shared/components/MagicPromptLoader', () => () => null);
jest.mock('../../../client/src/features/chat/components/ImageGenerationControls', () => () => (
  <div data-testid="image-controls" />
));
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: () => null
}));

const mockApi = {
  saveIntegrationPreferences: jest.fn(() => Promise.resolve({ stored: true })),
  fetchIntegrationPicker: jest.fn(),
  fetchIntegrationPreferences: jest.fn()
};
jest.mock('../../../client/src/api', () => mockApi);
jest.mock('../../../client/src/features/integrations/connect/integrationInfo', () => ({
  startIntegrationConnect: jest.fn(() => Promise.resolve())
}));
jest.mock('../../../client/src/features/office/contexts/EmbeddedHostContext', () => ({
  useEmbeddedHost: () => null
}));

const ChatInputActionsMenu =
  require('../../../client/src/features/chat/components/ChatInputActionsMenu').default;
const IntegrationChips =
  require('../../../client/src/features/integrations/picker/IntegrationChips').default;
const {
  isRowOn,
  setRowOn,
  effectSummary,
  scopeMapOf,
  matchesQuery
} = require('../../../client/src/features/integrations/picker/pickerState');
const useIntegrationPicker =
  require('../../../client/src/features/integrations/picker/useIntegrationPicker').default;
const useIntegrationDefaults =
  require('../../../client/src/features/integrations/picker/useIntegrationDefaults').default;
const {
  loadIntegrationDefaults,
  saveIntegrationDefault
} = require('../../../client/src/features/integrations/picker/useIntegrationDefaults');
const { AuthContext } = require('../../../client/src/shared/contexts/authContextValue');
const {
  startIntegrationConnect
} = require('../../../client/src/features/integrations/connect/integrationInfo');

const t = (_key, fallback) => fallback;

const ROWS = [
  {
    id: 'integration:ifinder',
    kind: 'integration',
    integration: 'ifinder',
    refs: ['ifinder'],
    coveredBy: [],
    name: 'iFinder',
    effects: ['read'],
    connection: { mode: 'sso', status: 'sso', connectable: false }
  },
  {
    id: 'integration:jira',
    kind: 'integration',
    integration: 'jira',
    refs: ['jira'],
    coveredBy: [],
    name: 'Jira & Confluence (EU)',
    effects: ['read', 'write'],
    connection: { mode: 'personal', status: 'not_connected', connectable: true }
  },
  {
    id: 'integration:enaio',
    kind: 'integration',
    integration: 'enaio',
    refs: ['enaio'],
    coveredBy: [],
    name: 'enaio DMS',
    effects: ['read', 'write'],
    connection: { mode: 'service_account', status: 'service_account', connectable: false }
  }
];

const SCOPE = {
  id: 'ifinder',
  name: 'iFinder',
  action: 'search',
  scopePicker: 'menu',
  fixed: false,
  defaultScope: 'standard',
  current: 'contracts',
  scopes: [
    { id: 'standard', name: 'Standard' },
    { id: 'contracts', name: 'Contracts' }
  ]
};

function openMenu(props = {}) {
  const onEnabledToolsChange = jest.fn();
  const connect = jest.fn(() => Promise.resolve());
  const utils = render(
    <ChatInputActionsMenu
      app={{ id: 'research', websearch: { enabled: true } }}
      enabledTools={['ifinder']}
      onEnabledToolsChange={onEnabledToolsChange}
      picker={{ rows: ROWS, loading: false, connect }}
      uploadConfig={{ localUploadEnabled: true, cloudStorage: { providers: [] } }}
      websearchEnabled={false}
      onWebsearchEnabledChange={jest.fn()}
      integrationScopes={[SCOPE]}
      onIntegrationScopeChange={jest.fn()}
      {...props}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Actions menu' }));
  return { ...utils, onEnabledToolsChange, connect, menu: screen.getByRole('menu') };
}

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
});

describe('pickerState', () => {
  const shared = [
    { id: 'a', refs: ['nc-main'], coveredBy: ['type:storage'] },
    { id: 'b', refs: ['nc-legal'], coveredBy: ['type:storage'] },
    { id: 'c', refs: ['jira'], coveredBy: [] }
  ];

  it('reads a row as on by its own reference or a binding that covers it', () => {
    expect(isRowOn(shared[0], ['type:storage'])).toBe(true);
    expect(isRowOn(shared[0], ['nc-main'])).toBe(true);
    expect(isRowOn(shared[0], ['jira'])).toBe(false);
    expect(isRowOn(shared[0], null)).toBe(false);
  });

  it('switches one installation of a shared binding off and keeps the other on', () => {
    expect(setRowOn(shared, ['type:storage', 'jira'], 'a', false)).toEqual(['jira', 'nc-legal']);
    expect(setRowOn(shared, ['jira'], 'a', true)).toEqual(['jira', 'nc-main']);
    expect(setRowOn(shared, ['jira'], 'c', false)).toEqual([]);
    // Already on through the binding: nothing to add.
    expect(setRowOn(shared, ['type:storage'], 'b', true)).toEqual(['type:storage']);
  });

  it('summarizes effects and builds the scope map a chat stores', () => {
    expect(effectSummary(['read', 'write', 'unknown'], t)).toBe('read · write');
    expect(scopeMapOf([SCOPE, { ...SCOPE, id: 'x', scopePicker: 'hidden' }])).toEqual({
      ifinder: 'contracts'
    });
    expect(matchesQuery({ name: 'Jira' }, 'ji')).toBe(true);
    expect(matchesQuery({ name: 'Jira' }, 'sharepoint')).toBe(false);
  });
});

describe('the "+" menu as the integrations picker', () => {
  it('shows three rows for three integrations, with their effect summary', () => {
    const { menu } = openMenu();
    expect(within(menu).getByText('Use in this chat')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemcheckbox', { name: /iFinder/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(within(menu).getByRole('menuitemcheckbox', { name: /enaio DMS/ })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    // The switch in a row is the shared SwitchIndicator: drawn only, hidden
    // from assistive technology, no nested control in the menu item.
    for (const [name, state] of [
      [/iFinder/, 'on'],
      [/enaio DMS/, 'off']
    ]) {
      const row = within(menu).getByRole('menuitemcheckbox', { name });
      const indicator = row.querySelector('[data-state]');
      expect(indicator).toHaveAttribute('aria-hidden', 'true');
      expect(indicator).toHaveAttribute('data-state', state);
      expect(row.querySelector('input, button, [role="switch"]')).toBeNull();
    }
    expect(within(menu).getByRole('menuitem', { name: /Jira & Confluence/ })).toHaveTextContent(
      'Connect →'
    );
    expect(within(menu).getAllByText('read · write')).toHaveLength(2);
    // Web search and upload are rows of the same menu.
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Web Search/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Upload file/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Manage integrations/ })).toBeInTheDocument();
  });

  it('switches a row for this chat only, by its references, with the keyboard too', () => {
    const { menu, onEnabledToolsChange } = openMenu();
    fireEvent.keyDown(within(menu).getByRole('menuitemcheckbox', { name: /enaio DMS/ }), {
      key: ' '
    });
    expect(onEnabledToolsChange).toHaveBeenCalledWith(['ifinder', 'enaio']);
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: /iFinder/ }));
    expect(onEnabledToolsChange).toHaveBeenLastCalledWith([]);
    expect(mockApi.saveIntegrationPreferences).not.toHaveBeenCalled();
  });

  it('shows the scope of a switched-on integration with its submenu', () => {
    const { menu } = openMenu();
    const scope = within(menu).getByRole('menuitem', { name: /iFinder: Search in Contracts/ });
    fireEvent.click(scope);
    expect(within(menu).getByRole('menuitemradio', { name: 'Contracts' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('connects a personal integration from its row', async () => {
    const { menu, connect } = openMenu();
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: /Jira & Confluence/ }));
    });
    expect(connect).toHaveBeenCalledWith(ROWS[1]);
  });

  it('filters by the search', () => {
    openMenu();
    fireEvent.change(screen.getByPlaceholderText('Search…'), {
      target: { value: 'enaio' }
    });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitemcheckbox', { name: /enaio/ })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitemcheckbox', { name: /iFinder/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search…'), {
      target: { value: 'nothing like it' }
    });
    expect(
      within(screen.getByRole('menu')).getByText('No integrations match.')
    ).toBeInTheDocument();
  });

  it("saves this chat's set as the default for new chats only when asked", async () => {
    const { menu } = openMenu({ websearchEnabled: true });
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: /Use as default/ }));
    });
    expect(mockApi.saveIntegrationPreferences).toHaveBeenCalledWith('research', {
      enabledTools: ['ifinder'],
      websearchEnabled: true,
      integrationScopes: { ifinder: 'contracts' }
    });
    expect(within(menu).getByText('Saved')).toBeInTheDocument();
  });

  it('closes on Escape in the search field and gives focus back to "+"', () => {
    openMenu();
    const search = screen.getByPlaceholderText('Search…');
    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Actions menu' })).toHaveFocus();
  });

  it('shows no menu when the server lists nothing and nothing else is offered', () => {
    render(
      <ChatInputActionsMenu
        app={{ id: 'demo', integrations: { ihub: { actions: ['ask_user'] } } }}
        enabledTools={['ihub']}
        picker={{ rows: [], loading: false }}
        uploadConfig={{}}
      />
    );
    expect(screen.queryByRole('button', { name: 'Actions menu' })).not.toBeInTheDocument();
  });
});

describe('the chips under the composer', () => {
  it('show the integrations switched on, with status and scope', () => {
    render(
      <IntegrationChips
        rows={ROWS}
        enabledTools={['ifinder', 'jira']}
        websearch={{ available: true, enabled: true, onChange: jest.fn() }}
        scopeIntegrations={[SCOPE]}
        onScopeChange={jest.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Web search is on — turn it off' })).toBeVisible();
    expect(screen.getByText('iFinder')).toBeInTheDocument();
    expect(screen.getByText('Contracts')).toBeInTheDocument();
    expect(screen.getByText('Jira & Confluence (EU)')).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByText('enaio DMS')).toBeNull();
  });

  it('turn the scope into a dropdown for an app that shows it inline', () => {
    const onScopeChange = jest.fn();
    render(
      <IntegrationChips
        rows={ROWS}
        enabledTools={['ifinder']}
        scopeIntegrations={[{ ...SCOPE, scopePicker: 'inline' }]}
        onScopeChange={onScopeChange}
      />
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'iFinder: Search in' }), {
      target: { value: 'standard' }
    });
    expect(onScopeChange).toHaveBeenCalledWith('ifinder', 'standard');
  });
});

describe('back from a sign-in in the same chat', () => {
  function Harness({ initial }) {
    const [enabledTools, setEnabledTools] = require('react').useState(initial);
    const picker = useIntegrationPicker({
      app: { id: 'research' },
      language: 'en',
      enabledTools,
      onEnabledToolsChange: setEnabledTools
    });
    return (
      <div>
        <span data-testid="tools">{enabledTools.join(',')}</span>
        <button type="button" onClick={() => picker.connect(picker.rows[1])}>
          connect
        </button>
      </div>
    );
  }

  it('turns the row on when the page comes back with integration_connected', async () => {
    mockApi.fetchIntegrationPicker.mockResolvedValue(ROWS);
    window.history.replaceState(null, '', '/apps/research/c1?integration_connected=jira');
    render(<Harness initial={['ifinder']} />);
    await waitFor(() => expect(screen.getByTestId('tools')).toHaveTextContent('ifinder,jira'));
    // The result parameters are gone from the address.
    expect(window.location.search).toBe('');
  });

  it('opens the consent in a new tab and switches the row on in this chat', async () => {
    mockApi.fetchIntegrationPicker.mockResolvedValue(ROWS);
    window.history.replaceState(null, '', '/apps/research/c2');
    const tab = { closed: false, location: {}, close: jest.fn() };
    const open = jest.spyOn(window, 'open').mockReturnValue(tab);
    startIntegrationConnect.mockImplementation(async (_id, { navigate }) =>
      navigate('https://vendor.example/authorize')
    );
    render(<Harness initial={['ifinder']} />);
    await waitFor(() => expect(mockApi.fetchIntegrationPicker).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    });
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('https://vendor.example/authorize');
    expect(tab.opener).toBeNull();
    expect(screen.getByTestId('tools')).toHaveTextContent('ifinder,jira');
    open.mockRestore();
  });
});

describe('the default for new chats', () => {
  it('imports what this browser kept once, and only when the server has none', async () => {
    mockApi.fetchIntegrationPreferences.mockResolvedValue({
      stored: false,
      available: true,
      preferences: { enabledTools: ['ifinder', 'jira'], websearchEnabled: false }
    });
    mockApi.saveIntegrationPreferences.mockResolvedValue({
      stored: true,
      available: true,
      preferences: { enabledTools: ['jira'], websearchEnabled: true }
    });
    sessionStorage.setItem(
      'ai_hub_app_settings_research',
      JSON.stringify({ enabledTools: ['jira'], websearchEnabled: true, selectedStyle: 'brief' })
    );
    const answer = await loadIntegrationDefaults('research');
    expect(answer.preferences.enabledTools).toEqual(['jira']);
    expect(mockApi.saveIntegrationPreferences).toHaveBeenCalledWith(
      'research',
      { enabledTools: ['jira'], websearchEnabled: true },
      { importOnce: true }
    );
    expect(JSON.parse(sessionStorage.getItem('ai_hub_app_settings_research'))).toEqual({
      selectedStyle: 'brief'
    });

    // The next load finds nothing left to import.
    mockApi.saveIntegrationPreferences.mockClear();
    await loadIntegrationDefaults('research');
    expect(mockApi.saveIntegrationPreferences).not.toHaveBeenCalled();
  });

  it('does not import over a default the user already has', async () => {
    mockApi.fetchIntegrationPreferences.mockResolvedValue({
      stored: true,
      available: true,
      preferences: { enabledTools: ['ifinder'] }
    });
    sessionStorage.setItem(
      'ai_hub_app_settings_research',
      JSON.stringify({ enabledTools: ['jira'] })
    );
    const answer = await loadIntegrationDefaults('research');
    expect(answer.preferences.enabledTools).toEqual(['ifinder']);
    expect(mockApi.saveIntegrationPreferences).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem('ai_hub_app_settings_research'))).toEqual({});
  });

  it('hands a default saved from the picker to the next chat without a reload', async () => {
    mockApi.fetchIntegrationPreferences.mockResolvedValue({
      stored: true,
      available: true,
      preferences: { enabledTools: ['ifinder'] }
    });
    function Defaults() {
      const { loading, preferences } = useIntegrationDefaults('research');
      return (
        <span data-testid="default">
          {loading ? 'loading' : preferences.enabledTools.join(',')}
        </span>
      );
    }
    render(<Defaults />);
    await waitFor(() => expect(screen.getByTestId('default')).toHaveTextContent('ifinder'));
    mockApi.saveIntegrationPreferences.mockResolvedValue({
      stored: true,
      available: true,
      preferences: { enabledTools: ['ifinder', 'jira'] }
    });
    await act(async () => {
      await saveIntegrationDefault('research', { enabledTools: ['ifinder', 'jira'] });
    });
    expect(screen.getByTestId('default')).toHaveTextContent('ifinder,jira');
    expect(mockApi.fetchIntegrationPreferences).toHaveBeenCalledTimes(1);
  });
});

describe('a sign-in while the composer stays mounted', () => {
  function Rows() {
    const picker = useIntegrationPicker({
      app: { id: 'research' },
      language: 'en',
      enabledTools: [],
      onEnabledToolsChange: jest.fn()
    });
    return <span data-testid="rows">{picker.loading ? 'loading' : picker.rows.length}</span>;
  }
  function Defaults() {
    const { loading, preferences } = useIntegrationDefaults('research');
    return (
      <span data-testid="default">{loading ? 'loading' : String(preferences?.enabledTools)}</span>
    );
  }
  const as = (auth, ui) => <AuthContext.Provider value={auth}>{ui}</AuthContext.Provider>;
  const guest = { isLoading: false, isAuthenticated: false, user: null };
  const alice = { isLoading: false, isAuthenticated: true, user: { id: 'alice' } };

  it('waits for the sign-in to resolve, then loads the rows again for the new viewer', async () => {
    mockApi.fetchIntegrationPicker.mockResolvedValueOnce([ROWS[0]]).mockResolvedValueOnce(ROWS);
    const { rerender } = render(as({ isLoading: true }, <Rows />));
    expect(screen.getByTestId('rows')).toHaveTextContent('loading');
    expect(mockApi.fetchIntegrationPicker).not.toHaveBeenCalled();
    rerender(as(guest, <Rows />));
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('1'));
    rerender(as(alice, <Rows />));
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('3'));
    expect(mockApi.fetchIntegrationPicker).toHaveBeenCalledTimes(2);
  });

  it("does not use the previous viewer's default", async () => {
    mockApi.fetchIntegrationPreferences
      .mockResolvedValueOnce({ stored: false, available: true, preferences: { enabledTools: [] } })
      .mockResolvedValueOnce({
        stored: true,
        available: true,
        preferences: { enabledTools: ['jira'] }
      });
    const { rerender } = render(as(guest, <Defaults />));
    await waitFor(() => expect(screen.getByTestId('default')).not.toHaveTextContent('loading'));
    rerender(as(alice, <Defaults />));
    // Loading again rather than the guest's answer, then Alice's own.
    expect(screen.getByTestId('default')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('default')).toHaveTextContent('jira'));
  });
});
