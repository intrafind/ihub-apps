import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * GroupMultiSelect Component Tests
 *
 * Covers the behaviour requested in issue #1922: a searchable group picker for
 * the user admin page that also allows adding names for non-existing groups
 * (used for external group mappings).
 */

// Mock i18n with simple interpolation so labels/aria-labels are realistic.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, opts) => {
      let str = defaultValue ?? key;
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

// Mock Icon so we can assert on which icon variant renders.
jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`}>{name}</span>;
  };
});

import GroupMultiSelect from '../../../client/src/features/admin/components/GroupMultiSelect';

const GROUPS = [
  { id: 'admins', name: 'Admins', description: 'Full access' },
  { id: 'users', name: 'Users' }
];

describe('GroupMultiSelect', () => {
  test('renders known groups by display name and custom values verbatim', () => {
    render(<GroupMultiSelect value={['admins', 'External-IdP-Group']} availableGroups={GROUPS} />);

    // Known group id resolves to its display name.
    expect(screen.getByText('Admins')).toBeInTheDocument();
    // Custom/external value is shown as-is.
    expect(screen.getByText('External-IdP-Group')).toBeInTheDocument();
  });

  test('clicking a matching group adds its id', () => {
    const onChange = jest.fn();
    render(<GroupMultiSelect value={[]} onChange={onChange} availableGroups={GROUPS} />);

    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'adm' } });

    fireEvent.click(screen.getByRole('option', { name: /Admins/ }));

    expect(onChange).toHaveBeenCalledWith(['admins']);
  });

  test('typing a non-existing name and pressing Enter adds it as a custom entry', () => {
    const onChange = jest.fn();
    render(<GroupMultiSelect value={[]} onChange={onChange} availableGroups={GROUPS} />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'External-IdP-Group' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith(['External-IdP-Group']);
  });

  test('typing a known group display name resolves to its canonical id', () => {
    const onChange = jest.fn();
    render(<GroupMultiSelect value={[]} onChange={onChange} availableGroups={GROUPS} />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Admins' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith(['admins']);
  });

  test('does not add duplicates (case-insensitive)', () => {
    const onChange = jest.fn();
    render(<GroupMultiSelect value={['admins']} onChange={onChange} availableGroups={GROUPS} />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'ADMINS' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalled();
  });

  test('removing a chip emits the remaining values', () => {
    const onChange = jest.fn();
    render(
      <GroupMultiSelect value={['admins', 'ext']} onChange={onChange} availableGroups={GROUPS} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Admins' }));

    expect(onChange).toHaveBeenCalledWith(['ext']);
  });

  test('flags custom entries by default but not when warnOnCustom is false', () => {
    const { rerender } = render(<GroupMultiSelect value={['ext']} availableGroups={[]} />);
    // Default: unknown entry is flagged with a warning icon.
    expect(screen.getByTestId('icon-exclamation-triangle')).toBeInTheDocument();

    rerender(<GroupMultiSelect value={['ext']} availableGroups={[]} warnOnCustom={false} />);
    // With warnOnCustom disabled (external-mappings use case) it renders neutrally.
    expect(screen.queryByTestId('icon-exclamation-triangle')).not.toBeInTheDocument();
    expect(screen.getByTestId('icon-users')).toBeInTheDocument();
  });

  test('does not offer a custom "add" option when allowCustom is false', () => {
    render(<GroupMultiSelect value={[]} availableGroups={GROUPS} allowCustom={false} />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'nope-not-a-group' } });

    expect(screen.queryByText(/Add "/)).not.toBeInTheDocument();
    expect(screen.getByText('No matching groups')).toBeInTheDocument();
  });
});
