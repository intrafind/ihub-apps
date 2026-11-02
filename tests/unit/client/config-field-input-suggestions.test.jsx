// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An install field with suggested values (iFinder's "User identity sent to
 * iFinder": email, username, id, …). It used to be a text box with a
 * <datalist>, which filtered the suggestions by the current value: a field
 * holding `email` offered only `email`. It is now a select of every
 * suggestion plus "Custom…" for any other value (a template such as
 * `CONTOSO\${user.username}`).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key, fallback, options) =>
      typeof fallback === 'string' && options?.field
        ? fallback.replace('{{field}}', options.field)
        : fallback,
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/features/admin/components/OpenApiToolEditor', () => ({
  CredentialRefSelect: () => null
}));
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: jest.fn(() => Promise.resolve({ items: [] }))
}));

const ConfigFieldInput =
  require('../../../client/src/features/admin/components/integrations/ConfigFieldInput').default;

const FIELD = {
  key: 'jwtSubjectField',
  type: 'string',
  title: { en: 'User identity sent to iFinder' },
  default: 'email',
  suggestions: ['email', 'username', 'id', 'name', 'domain\\username']
};

function renderField(value) {
  const onChange = jest.fn();
  render(<ConfigFieldInput field={FIELD} value={value} onChange={onChange} language="en" />);
  return { onChange, select: screen.getByLabelText('User identity sent to iFinder') };
}

describe('ConfigFieldInput field with suggestions', () => {
  it('offers every suggestion, whatever the current value, plus Custom', () => {
    const { select } = renderField('email');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('email');
    const options = [...select.querySelectorAll('option')].map(o => o.textContent);
    expect(options).toEqual(['email', 'username', 'id', 'name', 'domain\\username', 'Custom…']);
  });

  it('picks another suggestion', () => {
    const { select, onChange } = renderField('email');
    fireEvent.change(select, { target: { value: 'username' } });
    expect(onChange).toHaveBeenCalledWith('username');
    expect(screen.queryByLabelText(/Custom value/)).not.toBeInTheDocument();
  });

  it('opens a stored value that is no suggestion in the custom box', () => {
    const { select, onChange } = renderField('CONTOSO\\${user.username}');
    expect(select).toHaveValue('__custom__');
    const custom = screen.getByLabelText('Custom value for User identity sent to iFinder');
    expect(custom).toHaveValue('CONTOSO\\${user.username}');
    fireEvent.change(custom, { target: { value: 'ACME\\${user.username}' } });
    expect(onChange).toHaveBeenLastCalledWith('ACME\\${user.username}');
  });

  it('switches to the custom box without losing the value, and back to a suggestion', () => {
    const { select, onChange } = renderField('email');
    fireEvent.change(select, { target: { value: '__custom__' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Custom value/)).toHaveValue('email');
    fireEvent.change(select, { target: { value: 'id' } });
    expect(onChange).toHaveBeenCalledWith('id');
    expect(screen.queryByLabelText(/Custom value/)).not.toBeInTheDocument();
  });

  it('asks for a choice while the field is empty', () => {
    const { select } = renderField('');
    expect(select).toHaveValue('');
    expect(select.querySelector('option').textContent).toBe('Choose…');
  });
});
