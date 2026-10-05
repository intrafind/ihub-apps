/**
 * Settings → Integrations stays readable with many connections:
 *
 *   - a connected app is one row; its permissions open on demand;
 *   - rows are ordered by most recent use;
 *   - past five rows the rest hide behind "Show all", and a search box appears;
 *   - the API key endpoints are folded away until asked for;
 *   - plural and new strings exist in en and de.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const ConnectedAppsCard =
  require('../../../client/src/features/settings/components/ConnectedAppsCard').default;
const PersonalApiKeysCard =
  require('../../../client/src/features/settings/components/PersonalApiKeysCard').default;

beforeAll(async () => {
  await mockI18n.init({ lng: 'en', resources: { en: { translation: en } } });
});

const SCOPES = ['mcp:tools:read', 'mcp:tools:call', 'offline_access'];

function connection(clientId, overrides = {}) {
  return {
    clientId,
    userId: 'alice',
    clientName: clientId,
    clientHost: '',
    scopes: SCOPES,
    grantedAt: '2026-07-01T10:00:00.000Z',
    lastUsedAt: null,
    ...overrides
  };
}

describe('ConnectedAppsCard', () => {
  test('keeps permissions folded until the row is opened', () => {
    render(
      <ConnectedAppsCard
        connections={[connection('claude', { clientName: 'Claude Code', clientHost: 'claude.ai' })]}
        onDisconnect={jest.fn()}
      />
    );

    expect(screen.getByText('3 permissions', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Run iHub tools on your behalf')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /Claude Code/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Run iHub tools on your behalf')).toBeInTheDocument();
  });

  test('lists the most recently used connection first', () => {
    render(
      <ConnectedAppsCard
        connections={[
          connection('old', { grantedAt: '2026-01-01T00:00:00.000Z' }),
          connection('used', { lastUsedAt: '2026-09-30T00:00:00.000Z' }),
          connection('fresh', { grantedAt: '2026-09-01T00:00:00.000Z' })
        ]}
        onDisconnect={jest.fn()}
      />
    );

    const names = screen
      .getAllByRole('button', { expanded: false })
      .map(button => button.textContent.split(/Last used|Connected/)[0]);
    expect(names).toEqual(['used', 'fresh', 'old']);
  });

  test('shows five rows, then the rest on request, and searches all of them', () => {
    const connections = Array.from({ length: 7 }, (_, i) =>
      connection(`client-${i}`, {
        clientName: i === 6 ? 'Cursor' : `Claude Code ${i}`,
        lastUsedAt: `2026-09-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`
      })
    );
    render(<ConnectedAppsCard connections={connections} onDisconnect={jest.fn()} />);

    expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(5);
    expect(screen.queryByText('Cursor')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(5);

    const search = screen.getByRole('searchbox', { name: 'Search connected apps' });
    fireEvent.change(search, { target: { value: 'cursor' } });
    expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(1);
    expect(screen.getByText('Cursor')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'nothing' } });
    expect(screen.getByText('No connected apps match "nothing".')).toBeInTheDocument();
  });

  test('has no search box for a short list', () => {
    render(<ConnectedAppsCard connections={[connection('a')]} onDisconnect={jest.fn()} />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  test('disconnects the connection of the row', () => {
    const onDisconnect = jest.fn();
    const target = connection('claude', { clientName: 'Claude Code' });
    render(<ConnectedAppsCard connections={[target]} onDisconnect={onDisconnect} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith(target);
  });
});

describe('PersonalApiKeysCard', () => {
  test('folds the endpoints away until asked for', () => {
    render(
      <PersonalApiKeysCard
        limits={{ maxKeysPerUser: 5 }}
        endpoints={{
          baseUrl: 'https://ihub.example.com',
          mcp: 'https://ihub.example.com/mcp'
        }}
        keys={[]}
        onCreate={jest.fn()}
        onRotate={jest.fn()}
        onRevoke={jest.fn()}
      />
    );

    expect(screen.queryByDisplayValue('https://ihub.example.com/mcp')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /Endpoints/ });
    expect(within(toggle).getByText('2')).toBeInTheDocument();
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByDisplayValue('https://ihub.example.com/mcp')).toBeInTheDocument();
    // The primary action stays in view either way.
    expect(screen.getByRole('button', { name: 'Generate API key' })).toBeInTheDocument();
  });
});

describe('integrations page strings', () => {
  test.each([
    ['en', en, '1 permission', '6 permissions', 'Your accounts', 'Access to iHub'],
    ['de', de, '1 Berechtigung', '6 Berechtigungen', 'Ihre Konten', 'Zugriff auf iHub']
  ])('exist in %s', async (lng, resources, one, other, accounts, access) => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: resources } } });
    const key = 'integrations.page.connections.permissionCount';
    expect(i18n.t(key, { count: 1 })).toBe(one);
    expect(i18n.t(key, { count: 6 })).toBe(other);
    expect(i18n.t('integrations.page.sections.accounts.title')).toBe(accounts);
    expect(i18n.t('integrations.page.sections.access.title')).toBe(access);
    for (const name of ['search', 'noMatches', 'showAll', 'showFewer']) {
      expect(i18n.exists(`integrations.page.connections.${name}`)).toBe(true);
    }
  });
});
