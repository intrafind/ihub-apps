// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The members panel of a group: it lists who belongs to the group, adds the users
 * picked from the rest, removes a member, and says why when the server refuses.
 */

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, opts) => {
    let str = typeof defaultValue === 'string' ? defaultValue : key;
    if (opts && typeof str === 'string') {
      for (const [k, v] of Object.entries(opts)) {
        str = str.replace(new RegExp(`{{${k}}}`, 'g'), v);
      }
    }
    return str;
  };
  return { useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) };
});

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'failed'
}));

import GroupMembersSection from '../../../client/src/features/admin/components/GroupMembersSection';

const USERS = {
  a: { id: 'a', username: 'alice', name: 'Alice', email: 'alice@example.com', active: true },
  b: { id: 'b', username: 'bob', name: 'Bob', active: true },
  c: { id: 'c', username: 'carol', name: 'Carol', email: 'carol@example.com', active: true }
};

let members;
let removeFailure;

beforeEach(() => {
  members = [{ id: 'a', username: 'alice', name: 'Alice', active: true, authMethods: ['local'] }];
  removeFailure = null;
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation((url, options = {}) => {
    if (url === '/admin/auth/users') return Promise.resolve({ data: { users: USERS } });
    if (options.method === 'POST') {
      members = [
        ...members,
        ...options.body.userIds.map(id => ({
          id,
          username: USERS[id].username,
          name: USERS[id].name,
          active: true
        }))
      ];
      return Promise.resolve({ status: 201, data: { items: [] } });
    }
    if (options.method === 'DELETE') {
      if (removeFailure) return Promise.reject(removeFailure);
      const id = url.split('/').pop();
      members = members.filter(member => member.id !== id);
      return Promise.resolve({ status: 204 });
    }
    // A new array per response, as a real one is.
    return Promise.resolve({ data: { items: [...members] } });
  });
});

const renderSection = props => render(<GroupMembersSection groupId="team" {...props} />);

describe('GroupMembersSection', () => {
  test('lists the members, and offers only the other users for adding', async () => {
    renderSection();

    const list = await screen.findByTestId('group-members-list');
    expect(within(list).getByText('Alice')).toBeInTheDocument();
    const candidates = screen.getByTestId('group-members-candidates');
    expect(within(candidates).queryByText('Alice')).not.toBeInTheDocument();
    expect(within(candidates).getByText('Bob')).toBeInTheDocument();
    expect(within(candidates).getByText('Carol')).toBeInTheDocument();
  });

  test('searching narrows the users that can be added', async () => {
    renderSection();
    await screen.findByTestId('group-members-list');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'carol@' } });

    const candidates = screen.getByTestId('group-members-candidates');
    expect(within(candidates).queryByText('Bob')).not.toBeInTheDocument();
    expect(within(candidates).getByText('Carol')).toBeInTheDocument();
  });

  test('adds the selected users and shows them as members afterwards', async () => {
    renderSection();
    await screen.findByTestId('group-members-list');
    const addButton = screen.getByRole('button', { name: /Add 0 selected/ });
    expect(addButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/Bob/));
    fireEvent.click(screen.getByLabelText(/Carol/));
    fireEvent.click(screen.getByRole('button', { name: /Add 2 selected/ }));

    await waitFor(() => {
      expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/groups/team/members', {
        method: 'POST',
        body: { userIds: ['b', 'c'] }
      });
    });
    const list = await screen.findByTestId('group-members-list');
    await waitFor(() => expect(within(list).getByText('Bob')).toBeInTheDocument());
    expect(within(list).getByText('Carol')).toBeInTheDocument();
    expect(screen.getByText(/Every user is already a member/)).toBeInTheDocument();
  });

  test('removes a member', async () => {
    renderSection();
    await screen.findByTestId('group-members-list');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Alice from group' }));

    await waitFor(() => {
      expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/groups/team/members/a', {
        method: 'DELETE'
      });
    });
    expect(await screen.findByTestId('group-members-empty')).toBeInTheDocument();
  });

  test('refreshes in place after an add or remove: no loading state, focus on the search box', async () => {
    renderSection();
    await screen.findByTestId('group-members-list');
    const search = screen.getByRole('searchbox');
    const list = screen.getByTestId('group-members-list');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Alice from group' }));

    await screen.findByTestId('group-members-empty');
    // The panel never fell back to its loading text, and the search box is the same element.
    expect(screen.queryByText('Loading members…')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toBe(search);
    expect(search).toHaveFocus();
    expect(list).not.toBeInTheDocument();
  });

  test('Enter in the search box does not submit the form around the panel', async () => {
    renderSection();
    await screen.findByTestId('group-members-list');

    const notPrevented = fireEvent.keyDown(screen.getByRole('searchbox'), {
      key: 'Enter',
      code: 'Enter'
    });

    // fireEvent returns false when a handler called preventDefault.
    expect(notPrevented).toBe(false);
    // Other keys are left alone.
    expect(fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'a', code: 'KeyA' })).toBe(true);
  });

  test('shows the refusal of the server and keeps the member', async () => {
    removeFailure = {
      response: {
        status: 409,
        data: { code: 'LAST_ADMIN', detail: 'This change would leave no administrator.' }
      }
    };
    renderSection();
    await screen.findByTestId('group-members-list');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Alice from group' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no administrator/);
    expect(screen.getByTestId('group-members-list')).toHaveTextContent('Alice');
  });

  test('says that users of external mappings are not listed', async () => {
    renderSection({ hasExternalMappings: true });
    await screen.findByTestId('group-members-list');

    expect(screen.getByText(/external provider through the mappings/)).toBeInTheDocument();
  });
});
