// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Use for people search" on an LDAP sign-in provider leaves the
 * authentication page, so it is offered only for a saved provider and only
 * while nothing on the page is unsaved; otherwise it says to save first.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import LdapProvidersSection from '../../../client/src/features/admin/components/platform-form/LdapProvidersSection';

jest.mock('../../../client/src/features/admin/components/OpenApiToolEditor', () => ({
  CredentialRefSelect: () => null
}));
jest.mock('../../../client/src/features/admin/components/GroupMultiSelect', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/platform-form/LdapLoginTest', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

const CONFIG = {
  ldapAuth: {
    enabled: true,
    providers: [
      { name: 'corp-ad', displayName: 'Corporate AD', url: 'ldaps://dc.corp.example' },
      { name: 'branch', displayName: 'Branch', url: 'ldaps://dc.branch.example' }
    ]
  }
};

function renderSection(props) {
  return render(
    <MemoryRouter>
      <LdapProvidersSection config={CONFIG} onChange={() => {}} t={t} {...props} />
    </MemoryRouter>
  );
}

const LINK = /Use for people search/;
const SAVE_FIRST = 'Save the configuration to use this provider for people search';

describe('"Use for people search" on LDAP sign-in providers', () => {
  test('links a saved provider while nothing is unsaved', () => {
    renderSection({ savedProviderNames: ['corp-ad'], hasUnsavedChanges: false });
    const links = screen.getAllByRole('link', { name: LINK });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      '/admin/integrations/people-directories/new?authProvider=corp-ad&name=Corporate+AD'
    );
    // "branch" is only in the form, so a directory could not find it yet.
    expect(screen.queryByText(SAVE_FIRST)).not.toBeInTheDocument();
  });

  test('asks to save first while the page has unsaved changes', () => {
    renderSection({ savedProviderNames: ['corp-ad', 'branch'], hasUnsavedChanges: true });
    expect(screen.queryByRole('link', { name: LINK })).not.toBeInTheDocument();
    expect(screen.getAllByText(SAVE_FIRST)).toHaveLength(2);
  });
});
