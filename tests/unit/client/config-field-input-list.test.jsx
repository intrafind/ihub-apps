// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `list` install field of the integration wizard: the admin types one
 * entry per line, so Enter and the spaces of a half-typed line have to
 * survive each keystroke while the emitted value stays a normalized list.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key, fallback) => fallback,
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

const FIELD = { key: 'allowedSearchProfiles', type: 'list', title: { en: 'Profiles' } };

function renderList(props = {}) {
  const onChange = jest.fn();
  const utils = render(
    <ConfigFieldInput field={FIELD} value={props.value} onChange={onChange} language="en" />
  );
  return { onChange, textarea: screen.getByLabelText('Profiles'), ...utils };
}

describe('ConfigFieldInput list field', () => {
  it('shows the stored entries one per line', () => {
    const { textarea } = renderList({ value: ['contracts', 'hr'] });
    expect(textarea).toHaveValue('contracts\nhr');
  });

  it('keeps a trailing newline and spaces in the textarea while emitting the trimmed list', () => {
    const { textarea, onChange } = renderList({ value: ['contracts'] });
    fireEvent.change(textarea, { target: { value: 'contracts\n' } });
    expect(textarea).toHaveValue('contracts\n');
    expect(onChange).toHaveBeenLastCalledWith(['contracts']);

    fireEvent.change(textarea, { target: { value: 'contracts\nhr ' } });
    expect(textarea).toHaveValue('contracts\nhr ');
    expect(onChange).toHaveBeenLastCalledWith(['contracts', 'hr']);
  });

  it('emits an empty value when every line is blank', () => {
    const { textarea, onChange } = renderList({ value: ['contracts'] });
    fireEvent.change(textarea, { target: { value: '\n  \n' } });
    expect(textarea).toHaveValue('\n  \n');
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('re-seeds the text when the value changes from outside', () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <ConfigFieldInput field={FIELD} value={['a']} onChange={onChange} language="en" />
    );
    const textarea = screen.getByLabelText('Profiles');
    fireEvent.change(textarea, { target: { value: 'a\nb\n' } });
    // The parent stores the normalized list: the raw text stays as typed.
    rerender(
      <ConfigFieldInput field={FIELD} value={['a', 'b']} onChange={onChange} language="en" />
    );
    expect(textarea).toHaveValue('a\nb\n');
    // A different list (loaded installation, reset) replaces the text.
    rerender(<ConfigFieldInput field={FIELD} value={['x']} onChange={onChange} language="en" />);
    expect(textarea).toHaveValue('x');
  });
});
