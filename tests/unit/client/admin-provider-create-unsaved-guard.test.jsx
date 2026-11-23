// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * New provider form: after the provider is created the form is locked and the
 * delayed redirect to the list is never held by the unsaved-changes guard.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminProviderCreatePage from '../../../client/src/features/admin/pages/AdminProviderCreatePage';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));

jest.mock('../../../client/src/features/admin/hooks/useAdminPageAccess', () => ({
  __esModule: true,
  default: () => ({ models: true })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/providers/new']}>
      <Routes>
        <Route path="/admin/providers/new" element={<AdminProviderCreatePage />} />
        <Route path="/admin/providers" element={<p>providers list</p>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AdminProviderCreatePage after a successful create', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    makeAdminApiCall.mockResolvedValue({});
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('locks the form and redirects without a leave prompt', async () => {
    renderPage();
    const apiKey = screen.getByPlaceholderText('Enter API key');
    fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
      target: { value: 'My gateway' }
    });
    await act(async () => {
      const bar = screen.getByRole('region', { name: 'Save changes' });
      const buttons = within(bar).getAllByRole('button');
      fireEvent.click(buttons[buttons.length - 1]);
    });
    expect(makeAdminApiCall).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Provider created successfully!')).toBeInTheDocument();
    expect(apiKey).toBeDisabled();
    // Nothing is left to save: the bar is gone and offers no second save.
    expect(screen.queryByRole('region', { name: 'Save changes' })).not.toBeInTheDocument();

    // A change in the redirect window (the field is disabled, but the guard
    // must stay clean regardless).
    fireEvent.change(apiKey, { target: { value: 'typed-late' } });

    await act(async () => {
      jest.advanceTimersByTime(1600);
    });
    expect(screen.getByText('providers list')).toBeInTheDocument();
    expect(screen.queryByText('Leave without saving?')).not.toBeInTheDocument();
  });
});
