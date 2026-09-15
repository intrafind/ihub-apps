import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * ContentAccessSection — the "Group access" card on the content editors
 * (issue #2365). The server decides which groups are listed; the component
 * shows them, locks wildcard groups, and saves each tick on its own.
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

beforeEach(() => {
  mockFetchContentAccess.mockReset();
  mockUpdateContentAccess.mockReset();
});

describe('ContentAccessSection', () => {
  test('renders the groups the server returns, with wildcard groups locked', async () => {
    mockFetchContentAccess.mockResolvedValue(VIEW);

    render(<ContentAccessSection resourceType="apps" resourceId="chat" />);

    expect(mockFetchContentAccess).toHaveBeenCalledWith('apps', 'chat');

    const sales = await screen.findByRole('checkbox', { name: 'Sales can use this app' });
    expect(sales).not.toBeChecked();
    expect(sales).toBeEnabled();
    expect(screen.getByText('Also inherited from: users')).toBeInTheDocument();

    expect(screen.getByRole('checkbox', { name: 'EMEA Sales can use this app' })).toBeChecked();

    const power = screen.getByRole('checkbox', { name: 'Power Users can use this app' });
    expect(power).toBeChecked();
    expect(power).toBeDisabled();
    expect(screen.getByText(/Can use all apps through a wildcard/)).toBeInTheDocument();

    // A content admin is told why only some groups are listed.
    expect(screen.getByText(/groups you belong to/)).toBeInTheDocument();
  });

  test('ticking a group grants it and unticking revokes it, one request each', async () => {
    mockFetchContentAccess.mockResolvedValue(VIEW);
    const granted = {
      ...VIEW,
      groups: VIEW.groups.map(g => (g.id === 'sales' ? { ...g, granted: true } : g))
    };
    mockUpdateContentAccess.mockResolvedValueOnce(granted);

    render(<ContentAccessSection resourceType="apps" resourceId="chat" />);

    const sales = await screen.findByRole('checkbox', { name: 'Sales can use this app' });
    fireEvent.click(sales);

    expect(mockUpdateContentAccess).toHaveBeenCalledWith('apps', 'chat', { grant: ['sales'] });
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Sales can use this app' })).toBeChecked()
    );

    const revoked = {
      ...granted,
      groups: granted.groups.map(g => (g.id === 'emea-sales' ? { ...g, granted: false } : g))
    };
    mockUpdateContentAccess.mockResolvedValueOnce(revoked);
    fireEvent.click(screen.getByRole('checkbox', { name: 'EMEA Sales can use this app' }));
    expect(mockUpdateContentAccess).toHaveBeenLastCalledWith('apps', 'chat', {
      revoke: ['emea-sales']
    });
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: 'EMEA Sales can use this app' })
      ).not.toBeChecked()
    );
  });

  test('shows the server error when a change is refused and keeps the previous state', async () => {
    mockFetchContentAccess.mockResolvedValue(VIEW);
    mockUpdateContentAccess.mockRejectedValueOnce({
      response: { data: { error: 'not one of your groups' } }
    });

    render(<ContentAccessSection resourceType="apps" resourceId="chat" />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Sales can use this app' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not one of your groups');
    const sales = screen.getByRole('checkbox', { name: 'Sales can use this app' });
    expect(sales).not.toBeChecked();
    // The row is usable again once the refused request has settled.
    await waitFor(() => expect(sales).toBeEnabled());
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

    expect(await screen.findByRole('checkbox', { name: 'Sales can use this app' })).toBeVisible();
    expect(mockFetchContentAccess).toHaveBeenCalledTimes(2);
  });
});
