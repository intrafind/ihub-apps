// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import en from '../../../shared/i18n/en.json';

/**
 * The model's "Who can use this model" card: the groups that grant the model
 * said in words (with the wildcard and its inheritance chain), "Restrict
 * access…" while a wildcard covers the model, and the access check.
 */

const mockFetchItemAccess = jest.fn();
const mockFetchAccessVerdict = jest.fn();
const mockPreview = jest.fn();
const mockRestrict = jest.fn();

jest.mock('../../../client/src/api/adminApi', () => ({
  fetchItemAccess: (...args) => mockFetchItemAccess(...args),
  fetchAccessVerdict: (...args) => mockFetchAccessVerdict(...args),
  previewAccessRestriction: (...args) => mockPreview(...args),
  restrictItemAccess: (...args) => mockRestrict(...args),
  getAdminApiErrorMessage: err => err?.message || 'failed'
}));

const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, values = {}) =>
      String(lookup(key) ?? key).replace(/{{(\w+)}}/g, (_, name) => values?.[name] ?? ''),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

import ItemAccessCard from '../../../client/src/features/admin/components/access/ItemAccessCard';

const VIEW = {
  type: 'models',
  id: 'mistral',
  audience: { allSignedIn: true, anonymous: false },
  wildcardGroups: ['users', 'authenticated'],
  restrictable: true,
  groups: [
    {
      id: 'users',
      name: 'Users',
      effective: true,
      via: [
        { groupId: 'users', kind: 'wildcard', path: ['users'] },
        { groupId: 'authenticated', kind: 'wildcard', path: ['users', 'authenticated'] }
      ]
    },
    {
      id: 'hr',
      name: 'HR',
      effective: true,
      via: [{ groupId: 'users', kind: 'wildcard', path: ['hr', 'users'] }]
    },
    {
      id: 'authenticated',
      name: 'Authenticated',
      effective: true,
      implicit: true,
      via: [{ groupId: 'authenticated', kind: 'wildcard', path: ['authenticated'] }]
    },
    { id: 'kiosk', name: 'Kiosk', effective: false, via: [] }
  ]
};

const PLAN = {
  candidates: [
    { id: 'users', name: 'Users', itemCount: 2, currentCount: 3, passesTo: ['hr'], selected: true },
    {
      id: 'authenticated',
      name: 'Authenticated',
      itemCount: 2,
      currentCount: 3,
      passesTo: ['users', 'hr'],
      selected: true
    }
  ],
  selected: ['users', 'authenticated'],
  grantGroupIds: [],
  groupsAfter: [
    { id: 'users', name: 'Users', before: true, after: false, via: [] },
    { id: 'hr', name: 'HR', before: true, after: false, via: [] },
    { id: 'authenticated', name: 'Authenticated', before: true, after: false, implicit: true },
    { id: 'kiosk', name: 'Kiosk', before: false, after: false, via: [] }
  ],
  audienceBefore: { allSignedIn: true, anonymous: false },
  audienceAfter: { allSignedIn: false, anonymous: false },
  changes: [
    { groupId: 'users', action: 'restrict' },
    { groupId: 'authenticated', action: 'restrict' }
  ]
};

beforeEach(() => {
  mockFetchItemAccess.mockReset().mockResolvedValue(VIEW);
  mockFetchAccessVerdict.mockReset();
  mockPreview.mockReset().mockResolvedValue(PLAN);
  mockRestrict.mockReset();
});

const renderCard = () => render(<ItemAccessCard type="models" id="mistral" itemName="Mistral" />);

describe('ItemAccessCard', () => {
  it('says who can use the model and why, in visible text', async () => {
    renderCard();

    expect(await screen.findByTestId('item-access-audience')).toHaveTextContent(
      'Everyone who signs in can use this.'
    );
    expect(mockFetchItemAccess).toHaveBeenCalledWith('models', 'mistral');
    expect(
      screen.getByText('Everyone in Users sees this through “all models”.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Everyone in HR sees this through “all models” (inherited from Users: HR → Users).'
      )
    ).toBeInTheDocument();
    // A group without access, and the implicit group, are not listed as teams.
    const card = screen.getByTestId('item-access-card');
    const listed = within(card)
      .getAllByRole('listitem')
      .map(item => item.textContent);
    expect(listed.some(text => text.includes('Kiosk'))).toBe(false);
    expect(listed.some(text => text.startsWith('Everyone in Authenticated'))).toBe(false);
  });

  it('restricts the model through the dialog, with the new-items warning', async () => {
    const after = {
      ...VIEW,
      audience: { allSignedIn: false, anonymous: false },
      restrictable: false,
      wildcardGroups: [],
      groups: VIEW.groups.map(group => ({ ...group, effective: false, via: [] }))
    };
    mockRestrict.mockResolvedValue({ ...after, changed: ['users', 'authenticated'] });
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Restrict access…' }));
    const dialog = await screen.findByTestId('restrict-access-dialog');
    expect(mockPreview).toHaveBeenCalledWith('models', 'mistral', { grantGroupIds: [] });
    expect(await within(dialog).findByTestId('restrict-lose')).toHaveTextContent(
      'Can no longer use it: Users, HR'
    );
    expect(within(dialog).getByTestId('restrict-new-items-warning')).toHaveTextContent(
      'New models you add later no longer appear automatically'
    );
    expect(within(dialog).getByText('Passed on to: HR')).toBeInTheDocument();

    // Keep "all models" in Authenticated: the preview is asked again for users only.
    fireEvent.click(within(dialog).getByLabelText(/Authenticated/));
    await waitFor(() =>
      expect(mockPreview).toHaveBeenLastCalledWith('models', 'mistral', {
        groupIds: ['users'],
        grantGroupIds: []
      })
    );

    // Grant to Kiosk by name.
    fireEvent.click(within(dialog).getByLabelText('Kiosk'));
    await waitFor(() =>
      expect(mockPreview).toHaveBeenLastCalledWith('models', 'mistral', {
        groupIds: ['users'],
        grantGroupIds: ['kiosk']
      })
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restrict access' }));
    await waitFor(() =>
      expect(mockRestrict).toHaveBeenCalledWith('models', 'mistral', {
        groupIds: ['users'],
        grantGroupIds: ['kiosk']
      })
    );
    await waitFor(() =>
      expect(screen.queryByTestId('restrict-access-dialog')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('item-access-audience')).toHaveTextContent('No group can use this.');
    expect(screen.queryByRole('button', { name: 'Restrict access…' })).not.toBeInTheDocument();
  });

  it('runs the access check for a group and shows the reason chain', async () => {
    mockFetchAccessVerdict.mockResolvedValue({
      type: 'models',
      id: 'mistral',
      subject: { kind: 'group', id: 'kiosk', name: 'Kiosk', groups: ['kiosk'], notes: [] },
      verdict: 'unavailable',
      reasons: [
        { code: 'itemEnabled', status: 'ok' },
        { code: 'notGranted', status: 'blocked' }
      ]
    });
    renderCard();

    const check = await screen.findByTestId('access-check');
    fireEvent.change(within(check).getByLabelText('Group'), { target: { value: 'kiosk' } });
    fireEvent.click(within(check).getByRole('button', { name: 'Check access' }));

    const verdict = await within(check).findByTestId('access-verdict');
    expect(mockFetchAccessVerdict).toHaveBeenCalledWith('models', 'mistral', { groupId: 'kiosk' });
    expect(verdict).toHaveTextContent('Members of Kiosk cannot use this.');
    expect(verdict).toHaveTextContent('It is enabled.');
    expect(verdict).toHaveTextContent('No group of theirs grants it, by name or through “all”.');
  });

  it('checks a user by name and notes groups an identity provider sends', async () => {
    mockFetchAccessVerdict.mockResolvedValue({
      subject: {
        kind: 'user',
        id: 'user_olga',
        name: 'Olga',
        groups: ['hr', 'authenticated'],
        notes: ['identityProviderGroupsUnknown']
      },
      verdict: 'available',
      reasons: [
        {
          code: 'granted',
          status: 'ok',
          routes: [{ groupId: 'users', kind: 'wildcard', path: ['hr', 'users'] }]
        }
      ]
    });
    renderCard();

    const check = await screen.findByTestId('access-check');
    fireEvent.click(within(check).getByLabelText('A user'));
    fireEvent.change(within(check).getByLabelText('User'), { target: { value: 'olga' } });
    fireEvent.click(within(check).getByRole('button', { name: 'Check access' }));

    const verdict = await within(check).findByTestId('access-verdict');
    expect(mockFetchAccessVerdict).toHaveBeenCalledWith('models', 'mistral', { userId: 'olga' });
    expect(verdict).toHaveTextContent('Olga can use this.');
    expect(verdict).toHaveTextContent('Checked with the groups: HR, Authenticated');
    expect(verdict).toHaveTextContent(
      'Everyone in HR sees this through “all models” (inherited from Users: HR → Users).'
    );
    expect(verdict).toHaveTextContent('only the groups stored in iHub were checked');
  });

  it('shows the load error with a retry', async () => {
    mockFetchItemAccess
      .mockReset()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(VIEW);
    renderCard();

    expect(await screen.findByRole('alert')).toHaveTextContent('Access could not be loaded. boom');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('item-access-audience')).toBeInTheDocument();
  });

  it('says why everyone who signs in would still get the item', async () => {
    mockPreview.mockResolvedValue({
      ...PLAN,
      groupsAfter: [
        ...PLAN.groupsAfter.filter(row => row.id !== 'authenticated'),
        {
          id: 'authenticated',
          name: 'Authenticated',
          before: true,
          after: true,
          implicit: true,
          via: [{ groupId: 'anonymous', kind: 'explicit', path: ['authenticated', 'anonymous'] }]
        }
      ],
      audienceAfter: { allSignedIn: true, anonymous: true }
    });
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Restrict access…' }));
    expect(await screen.findByTestId('restrict-still-everyone')).toHaveTextContent(
      'Everyone who signs in can still use it:Everyone in Authenticated gets this by name from anonymous (Authenticated → anonymous).'
    );
  });
});
