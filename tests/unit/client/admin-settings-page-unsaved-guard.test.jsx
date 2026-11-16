// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminSettingsPage from '../../../client/src/features/admin/components/AdminSettingsPage';
import AdminFeaturesPage from '../../../client/src/features/admin/pages/AdminFeaturesPage';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';

/**
 * The settings frame and a real settings page guard against leaving with
 * unsaved changes, with the real useUnsavedChanges hook inside a router.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn()
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ refreshConfig: jest.fn() })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));

beforeAll(() => {
  global.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
});

function renderAt(element) {
  return render(
    <MemoryRouter initialEntries={['/admin/page']}>
      <Routes>
        <Route
          path="/admin/page"
          element={
            <>
              <Link to="/admin">Overview</Link>
              {element}
            </>
          }
        />
        <Route path="/admin" element={<p>overview page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const sections = [
  { id: 'a', label: 'Section A', children: <p>a</p> },
  { id: 'b', label: 'Section B', dirty: true, children: <p>b</p> }
];

describe('AdminSettingsPage', () => {
  it('lets the admin leave while nothing is dirty', () => {
    renderAt(<AdminSettingsPage title="Settings" sections={[sections[0]]} onSave={jest.fn()} />);
    fireEvent.click(screen.getByText('Overview'));
    expect(screen.getByText('overview page')).toBeInTheDocument();
  });

  it('asks "Leave without saving?" when dirty; Stay keeps the page, Discard leaves', () => {
    renderAt(
      <AdminSettingsPage title="Settings" sections={[sections[0]]} dirty onSave={jest.fn()} />
    );
    fireEvent.click(screen.getByText('Overview'));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Leave without saving?')).toBeInTheDocument();
    expect(within(dialog).getByText('Your changes will be lost.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Stay' })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Overview'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByText('overview page')).toBeInTheDocument();
  });

  it('guards a page whose only unsaved edits are in a self-saving section', () => {
    renderAt(<AdminSettingsPage title="Settings" sections={sections} />);
    fireEvent.click(screen.getByText('Overview'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('marks a dirty section in the section nav', () => {
    renderAt(<AdminSettingsPage title="Settings" sections={sections} />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByRole('button', { name: /Section B.*unsaved/ })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Section A' })).toBeInTheDocument();
  });

  it('uses the shared save bar: status text, translated labels, no pulse for reduced motion', () => {
    const onSave = jest.fn();
    renderAt(<AdminSettingsPage title="Settings" sections={[sections[0]]} dirty onSave={onSave} />);
    expect(screen.getByRole('status')).toHaveTextContent('You have unsaved changes');
    expect(screen.getByRole('region', { name: 'Save changes' })).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toHaveClass('motion-reduce:animate-none');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(onSave).toHaveBeenCalled();
  });
});

describe('AdminFeaturesPage unsaved-changes guard', () => {
  const features = [
    { id: 'alpha', name: 'Alpha', category: 'preview', enabled: false },
    { id: 'beta', name: 'Beta', category: 'preview', enabled: true }
  ];

  beforeEach(() => {
    makeAdminApiCall.mockReset();
    makeAdminApiCall.mockImplementation(async (url, options = {}) => {
      if (options.method === 'PUT') return { data: {} };
      return {
        data: { items: features, categories: { preview: { name: 'Preview', order: 1 } } }
      };
    });
  });

  async function renderFeatures() {
    renderAt(<AdminFeaturesPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('is not dirty right after loading', async () => {
    await renderFeatures();
    fireEvent.click(screen.getByText('Overview'));
    expect(screen.getByText('overview page')).toBeInTheDocument();
  });

  it('asks before leaving with a toggled switch, and not after saving it', async () => {
    await renderFeatures();
    fireEvent.click(screen.getAllByRole('switch')[0]);

    fireEvent.click(screen.getByText('Overview'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });
    fireEvent.click(screen.getByText('Overview'));
    expect(screen.getByText('overview page')).toBeInTheDocument();
  });

  it('is never dirty after a failed load', async () => {
    makeAdminApiCall.mockRejectedValue(new Error('429'));
    await renderFeatures();
    fireEvent.click(screen.getByText('Overview'));
    expect(screen.getByText('overview page')).toBeInTheDocument();
  });
});
