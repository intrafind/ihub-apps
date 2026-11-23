// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import en from '../../../shared/i18n/en.json';

/**
 * The access card on the app editor (`ItemAccessTools`): a full admin gets
 * "Restrict access…" and the check for any group or user over the full-admin
 * view; a content admin gets the check only, over the content-access view
 * (the groups they manage), with no user check and no restrict button.
 */

const mockFetchItemAccess = jest.fn();
const mockFetchContentAccess = jest.fn();
const mockFetchAccessVerdict = jest.fn();

jest.mock('../../../client/src/api/adminApi', () => ({
  fetchItemAccess: (...args) => mockFetchItemAccess(...args),
  fetchContentAccess: (...args) => mockFetchContentAccess(...args),
  fetchAccessVerdict: (...args) => mockFetchAccessVerdict(...args),
  previewAccessRestriction: jest.fn(),
  restrictItemAccess: jest.fn(),
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

import ItemAccessTools from '../../../client/src/features/admin/components/access/ItemAccessTools';

const wildcardVia = [{ groupId: 'users', kind: 'wildcard', path: ['users'] }];

/** The full-admin view: every group, the wildcard the restrict action converts. */
const FULL_VIEW = {
  type: 'apps',
  id: 'chat',
  audience: { allSignedIn: true, anonymous: false },
  wildcardGroups: ['users'],
  restrictable: true,
  groups: [
    { id: 'users', name: 'Users', effective: true, via: wildcardVia },
    { id: 'hr', name: 'HR', effective: true, via: wildcardVia },
    { id: 'kiosk', name: 'Kiosk', effective: false, via: [] }
  ]
};

/** The content-access view of a content admin in `users`: their groups only. */
const CONTENT_VIEW = {
  type: 'apps',
  id: 'chat',
  scope: 'membership',
  audience: { allSignedIn: true, anonymous: false },
  groups: [
    { id: 'users', name: 'Users', wildcard: true, effective: true, via: wildcardVia },
    { id: 'hr', name: 'HR', effective: true, via: wildcardVia }
  ]
};

const VERDICT = {
  type: 'apps',
  id: 'chat',
  subject: { kind: 'group', id: 'hr', name: 'HR', groups: ['hr', 'users'] },
  verdict: 'available',
  reasons: [{ code: 'itemEnabled', status: 'ok' }]
};

beforeEach(() => {
  mockFetchItemAccess.mockReset().mockResolvedValue(FULL_VIEW);
  mockFetchContentAccess.mockReset().mockResolvedValue(CONTENT_VIEW);
  mockFetchAccessVerdict.mockReset().mockResolvedValue(VERDICT);
});

describe('ItemAccessTools', () => {
  it('gives a full admin restrict, the user check and every group', async () => {
    render(<ItemAccessTools type="apps" id="chat" itemName="Chat" />);

    expect(
      await screen.findByRole('heading', { name: en.admin.access.tools.title })
    ).toBeInTheDocument();
    expect(mockFetchItemAccess).toHaveBeenCalledWith('apps', 'chat');
    expect(mockFetchContentAccess).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: new RegExp(en.admin.access.restrict.open) })
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: en.admin.access.check.byUser })).toBeInTheDocument();
    const options = screen.getAllByRole('option').map(option => option.value);
    expect(options).toEqual(['users', 'hr', 'kiosk']);
  });

  it('gives a content admin the check for their own groups only, without restrict', async () => {
    render(<ItemAccessTools type="apps" id="chat" itemName="Chat" fullAdmin={false} />);

    expect(
      await screen.findByRole('heading', { name: en.admin.access.tools.checkTitle })
    ).toBeInTheDocument();
    expect(mockFetchContentAccess).toHaveBeenCalledWith('apps', 'chat');
    expect(mockFetchItemAccess).not.toHaveBeenCalled();
    expect(screen.queryByText(en.admin.access.tools.title)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: new RegExp(en.admin.access.restrict.open) })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByText(en.admin.access.check.descriptionGroupsOnly)).toBeInTheDocument();

    const select = screen.getByLabelText(en.admin.access.check.groupLabel);
    expect(screen.getAllByRole('option').map(option => option.value)).toEqual(['users', 'hr']);

    fireEvent.change(select, { target: { value: 'hr' } });
    fireEvent.click(screen.getByRole('button', { name: en.admin.access.check.run }));
    await waitFor(() =>
      expect(mockFetchAccessVerdict).toHaveBeenCalledWith('apps', 'chat', { groupId: 'hr' })
    );
    expect(await screen.findByTestId('access-verdict')).toBeInTheDocument();
  });
});
