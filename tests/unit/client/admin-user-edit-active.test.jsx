// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * The user editor and the account's `active` flag (ID-B3), and refusals (ID-B2).
 *
 * - Saving an unrelated edit leaves a deactivated account deactivated: the
 *   editor sends `active` only when the Enabled switch changed. It used to
 *   send `active: data.enabled !== false`, and the stored record has no
 *   `enabled`, so every save re-enabled the account.
 * - Unticking Enabled sends `active: false` (the switch set two fields from a
 *   stale copy, so only one of them stuck).
 * - Your own account's switch is disabled: the server refuses it anyway.
 * - A refusal (409 LAST_ADMIN) is shown on the page; the edits stay.
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
  const i18n = { language: 'en' };
  return { useTranslation: () => ({ t: translate, i18n }) };
});

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'failed',
  fetchAdminUsageLimitUser: jest.fn(() => Promise.resolve({ buckets: [] })),
  resetAdminUsageLimitUser: jest.fn(() => Promise.resolve({ buckets: [] }))
}));

jest.mock('../../../client/src/utils/schemaService', () => ({
  getSchemaByType: jest.fn(() => Promise.resolve(null))
}));

let mockCurrentUserId = 'admin';
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: mockCurrentUserId, isAdmin: true } })
}));

// The JSON mode is not under test: render the form the page hands over.
jest.mock('../../../client/src/shared/components/DualModeEditor', () => {
  return function DualModeEditor({ value, onChange, formComponent: Form, formProps }) {
    return <Form value={value} onChange={onChange} {...formProps} />;
  };
});

jest.mock('../../../client/src/features/admin/components/UsageLimitsEditor', () => {
  const actual = jest.requireActual(
    '../../../client/src/features/admin/components/UsageLimitsEditor'
  );
  return { __esModule: true, ...actual, default: () => null };
});

import AdminUserEditPage from '../../../client/src/features/admin/pages/AdminUserEditPage';
import { buildUserSavePayload } from '../../../client/src/features/admin/utils/userSavePayload';

const DISABLED_USER = {
  id: 'user_d',
  username: 'dora',
  email: 'dora@example.com',
  active: false,
  internalGroups: ['users'],
  authMethods: ['local']
};

function mockApi(user, onWrite = () => Promise.resolve({ data: {} })) {
  mockMakeAdminApiCall.mockImplementation((url, options = {}) => {
    if (options.method) return onWrite(url, options);
    if (url === '/admin/auth/users') {
      return Promise.resolve({ data: { users: { [user.id]: user } } });
    }
    return Promise.resolve({ data: { groups: {} } });
  });
}

const writes = () => mockMakeAdminApiCall.mock.calls.filter(([, options]) => options?.method);

function renderEditor(userId) {
  return render(
    <MemoryRouter initialEntries={[`/admin/users/${userId}`]}>
      <Routes>
        <Route path="/admin/users/:userId" element={<AdminUserEditPage />} />
        <Route path="/admin/users" element={<div>Users list</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  mockCurrentUserId = 'admin';
});

describe('AdminUserEditPage and active', () => {
  test('editing the email of a deactivated user does not send active', async () => {
    mockApi(DISABLED_USER);
    renderEditor('user_d');

    fireEvent.change(await screen.findByPlaceholderText('Enter email address'), {
      target: { value: 'new@example.com' }
    });
    expect(screen.getByLabelText('Enabled')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('Users list')).toBeInTheDocument();
    const [url, options] = writes()[0];
    expect(url).toBe('/admin/auth/users/user_d');
    expect(options.method).toBe('PUT');
    expect(options.body.email).toBe('new@example.com');
    expect(options.body).not.toHaveProperty('active');
  });

  test('unticking Enabled sends active: false', async () => {
    mockApi({ ...DISABLED_USER, active: true });
    renderEditor('user_d');

    fireEvent.click(await screen.findByLabelText('Enabled'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][1].body.active).toBe(false);
  });

  test('your own account cannot be deactivated from the editor', async () => {
    mockCurrentUserId = 'user_d';
    mockApi({ ...DISABLED_USER, active: true });
    renderEditor('user_d');

    expect(await screen.findByLabelText('Enabled')).toBeDisabled();
    expect(screen.getByText('You cannot deactivate your own account.')).toBeInTheDocument();
  });

  test('a refusal is shown on the page and the edits stay', async () => {
    mockApi({ ...DISABLED_USER, active: true, internalGroups: ['admins'] }, () =>
      Promise.reject({
        response: {
          status: 409,
          data: {
            code: 'LAST_ADMIN',
            detail: 'This change would leave no active administrator who can sign in.'
          }
        }
      })
    );
    renderEditor('user_d');

    fireEvent.change(await screen.findByPlaceholderText('Enter email address'), {
      target: { value: 'kept@example.com' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This change would leave no active administrator who can sign in.'
    );
    expect(screen.queryByText('Users list')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter email address')).toHaveValue('kept@example.com');
  });
});

describe('AdminUserEditPage: the baseline for active', () => {
  function GoTo({ path }) {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate(path)}>
        go
      </button>
    );
  }

  test('a load the editor discarded is not the baseline (out-of-order responses)', async () => {
    const userA = { ...DISABLED_USER, id: 'user_a', username: 'anna', active: false };
    const userB = { ...DISABLED_USER, id: 'user_b', username: 'bert', active: true };
    const users = { [userA.id]: userA, [userB.id]: userB };
    let releaseFirst;
    let reads = 0;
    mockMakeAdminApiCall.mockImplementation((url, options = {}) => {
      if (options.method) return Promise.resolve({ data: {} });
      if (url === '/admin/auth/users') {
        reads += 1;
        if (reads === 1) {
          return new Promise(resolve => {
            releaseFirst = () => resolve({ data: { users } });
          });
        }
        return Promise.resolve({ data: { users } });
      }
      return Promise.resolve({ data: { groups: {} } });
    });

    render(
      <MemoryRouter initialEntries={['/admin/users/user_a']}>
        <GoTo path="/admin/users/user_b" />
        <Routes>
          <Route path="/admin/users/:userId" element={<AdminUserEditPage />} />
          <Route path="/admin/users" element={<div>Users list</div>} />
        </Routes>
      </MemoryRouter>
    );

    // Switch to bert before anna's load answers; anna's answer comes last.
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(await screen.findByLabelText('Enabled')).toBeChecked();
    await act(async () => releaseFirst());

    fireEvent.click(screen.getByLabelText('Enabled'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toBe('/admin/auth/users/user_b');
    expect(writes()[0][1].body.active).toBe(false);
  });

  test('after a failed save that sent active, the next save sends the status choice', async () => {
    let attempt = 0;
    mockApi(DISABLED_USER, () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('Network Error'))
        : Promise.resolve({ data: {} });
    });
    renderEditor('user_d');

    // Enable; the response is lost, so the server may have stored active: true.
    fireEvent.click(await screen.findByLabelText('Enabled'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    // Back to disabled, which equals the loaded user: it must still be sent.
    fireEvent.click(screen.getByLabelText('Enabled'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1][1].body.active).toBe(false);
  });
});

describe('AdminUserEditPage: the uncertain active flag belongs to one user', () => {
  function GoTo({ path }) {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate(path)}>
        go
      </button>
    );
  }

  test("a save of user A that fails after the editor moved to user B does not force active into B's save", async () => {
    const userA = { ...DISABLED_USER, id: 'user_a', username: 'anna', active: false };
    const userB = {
      ...DISABLED_USER,
      id: 'user_b',
      username: 'bert',
      email: 'bert-old@example.com',
      active: true
    };
    const users = { [userA.id]: userA, [userB.id]: userB };
    let failFirstSave;
    let saves = 0;
    mockMakeAdminApiCall.mockImplementation((url, options = {}) => {
      if (options.method) {
        saves += 1;
        if (saves === 1) {
          return new Promise((resolve, reject) => {
            failFirstSave = () => reject(new Error('Network Error'));
          });
        }
        return Promise.resolve({ data: {} });
      }
      if (url === '/admin/auth/users') return Promise.resolve({ data: { users } });
      return Promise.resolve({ data: { groups: {} } });
    });

    render(
      <MemoryRouter initialEntries={['/admin/users/user_a']}>
        <GoTo path="/admin/users/user_b" />
        <Routes>
          <Route path="/admin/users/:userId" element={<AdminUserEditPage />} />
          <Route path="/admin/users" element={<div>Users list</div>} />
        </Routes>
      </MemoryRouter>
    );

    // Enable anna and save; the request is still running when the editor moves on.
    fireEvent.click(await screen.findByLabelText('Enabled'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    const discard = screen.queryByRole('button', { name: 'Discard changes' });
    if (discard) fireEvent.click(discard);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Enter email address')).toHaveValue('bert-old@example.com')
    );

    // Anna's save fails now, with bert loaded.
    await act(async () => failFirstSave());

    fireEvent.change(screen.getByPlaceholderText('Enter email address'), {
      target: { value: 'bert@example.com' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1][0]).toBe('/admin/auth/users/user_b');
    expect(writes()[1][1].body.email).toBe('bert@example.com');
    expect(writes()[1][1].body).not.toHaveProperty('active');
  });
});

describe('buildUserSavePayload', () => {
  test('a create always sends active', () => {
    expect(buildUserSavePayload({ username: 'n', active: true }, { isNew: true }).active).toBe(
      true
    );
  });

  test('an update sends active only when it changed', () => {
    const initial = { username: 'd', active: false };
    expect(buildUserSavePayload({ ...initial }, { isNew: false, initial })).not.toHaveProperty(
      'active'
    );
    expect(
      buildUserSavePayload({ ...initial, active: true }, { isNew: false, initial }).active
    ).toBe(true);
  });
});
