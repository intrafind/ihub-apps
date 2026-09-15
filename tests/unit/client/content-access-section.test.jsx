import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * ContentAccessSection — the "Group access" card on the content editors
 * (issue #2365). The server decides which groups are listed; the component
 * shows the granted ones as removable chips, offers a search box to grant
 * more (issue #2377 — a plain checkbox list did not scale to many groups),
 * locks wildcard groups, and saves each change on its own.
 */

const mockFetchContentAccess = jest.fn();
const mockUpdateContentAccess = jest.fn();

jest.mock('../../../client/src/api/adminApi', () => ({
  fetchContentAccess: (...args) => mockFetchContentAccess(...args),
  updateContentAccess: (...args) => mockUpdateContentAccess(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.error || err?.message || 'failed'
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, opts) => {
      let str = typeof defaultValue === 'string' ? defaultValue : key;
      if (opts && typeof str === 'string') {
        for (const [k, v] of Object.entries(opts)) {
          str = str.replace(new RegExp(`{{${k}}}`, 'g'), v);
        }
      }
      return str;
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`}>{name}</span>;
  };
});

import ContentAccessSection from '../../../client/src/features/admin/components/ContentAccessSection';

const VIEW = {
  type: 'apps',
  id: 'chat',
  scope: 'membership',
  groups: [
    {
      id: 'sales',
      name: 'Sales',
      description: 'Sales team',
      granted: false,
      wildcard: false,
      inheritedFrom: ['users'],
      effective: true
    },
    {
      id: 'emea-sales',
      name: 'EMEA Sales',
      description: '',
      granted: true,
      wildcard: false,
      inheritedFrom: [],
      effective: true
    },
    {
      id: 'power-users',
      name: 'Power Users',
      description: '',
      granted: false,
      wildcard: true,
      inheritedFrom: [],
      effective: true
    }
  ]
};

const openSearch = async () => {
  const search = await screen.findByRole('combobox', { name: 'Search groups to grant access' });
  fireEvent.focus(search);
  return search;
};

beforeEach(() => {
  mockFetchContentAccess.mockReset();
  mockUpdateContentAccess.mockReset();
});

describe('ContentAccessSection', () => {
  test('shows granted groups as chips, wildcard groups locked, and the rest in the search dropdown', async () => {
    mockFetchContentAccess.mockResolvedValue(VIEW);

    render(<ContentAccessSection resourceType="apps" resourceId="chat" />);

    expect(mockFetchContentAccess).toHaveBeenCalledWith('apps', 'chat');

    // Granted groups render as chips, not in the search results.
    expect(await screen.findByText('EMEA Sales')).toBeInTheDocument();
    const power = screen.getByText('Power Users').closest('span');
    expect(power).toHaveTextContent('Power Users');
    // A wildcard chip has no remove button.
    expect(screen.queryByRole('button', { name: 'Remove Power Users' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove EMEA Sales' })).toBeInTheDocument();

    // A content admin is told why only some groups are listed.
    expect(screen.getByText(/groups you belong to/)).toBeInTheDocument();

    // Sales is not yet granted, so it shows up in the search dropdown with
    // its inherited-access hint instead of as a chip.
    await openSearch();
    const salesOption = await screen.findByRole('option', { name: /Sales/ });
    expect(salesOption).toHaveTextContent('Also inherited from: users');
  });

  test('picking a group in the search dropdown grants it, and removing its chip revokes it', async () => {
    mockFetchContentAccess.mockResolvedValue(VIEW);
    const granted = {
      ...VIEW,
      groups: VIEW.groups.map(g => (g.id === 'sales' ? { ...g, granted: true } : g))
    };
    mockUpdateContentAccess.mockResolvedValueOnce(granted);

    render(<ContentAccessSection resourceType="apps" resourceId="chat" />);

    const search = await openSearch();
    fireEvent.change(search, { target: { value: 'sal' } });
    fireEvent.click(await screen.findByRole('option', { name: /Sales/ }));

    expect(mockUpdateContentAccess).toHaveBeenCalledWith('apps', 'chat', { grant: ['sales'] });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove Sales' })).toBeInTheDocument()
    );

    const revoked = {
      ...granted,
      groups: granted.groups.map(g => (g.id === 'emea-sales' ? { ...g, granted: false } : g))
    };
    mockUpdateContentAccess.mockResolvedValueOnce(revoked);
    fireEvent.click(screen.getByRole('button', { name: 'Remove EMEA Sales' }));
    expect(mockUpdateContentAccess).toHaveBeenLastCalledWith('apps', 'chat', {
      revoke: ['emea-sales']
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove EMEA Sales' })).not.toBeInTheDocument()
    );
  });

  test('shows the server error when a change is refused and keeps the previous state', async () => {
    mockFetchContentAccess.mockResolvedValue(VIEW);
    mockUpdateContentAccess.mockRejectedValueOnce({
      response: { data: { error: 'not one of your groups' } }
    });

    render(<ContentAccessSection resourceType="apps" resourceId="chat" />);

    const search = await openSearch();
    fireEvent.change(search, { target: { value: 'sal' } });
    fireEvent.click(await screen.findByRole('option', { name: /Sales/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not one of your groups');
    // The refused grant never happened, so Sales is still in the search pool.
    fireEvent.change(search, { target: { value: 'sal' } });
    expect(await screen.findByRole('option', { name: /Sales/ })).toBeInTheDocument();
  });

  test('asks to save first for content that does not exist yet, without calling the API', () => {
    render(<ContentAccessSection resourceType="prompts" resourceId="new" isNew />);

    expect(screen.getByText(/Save this prompt first/)).toBeInTheDocument();
    expect(mockFetchContentAccess).not.toHaveBeenCalled();
  });

  test('explains an empty membership scope', async () => {
    mockFetchContentAccess.mockResolvedValue({ ...VIEW, groups: [] });

    render(<ContentAccessSection resourceType="apps" resourceId="chat" />);

    expect(
      await screen.findByText(/not a member of any group whose access you may manage/)
    ).toBeInTheDocument();
  });

  test('offers a retry when loading fails', async () => {
    mockFetchContentAccess.mockRejectedValueOnce(new Error('boom'));
    mockFetchContentAccess.mockResolvedValueOnce(VIEW);

    render(<ContentAccessSection resourceType="apps" resourceId="chat" />);

    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('EMEA Sales')).toBeVisible();
    expect(mockFetchContentAccess).toHaveBeenCalledTimes(2);
  });
});
