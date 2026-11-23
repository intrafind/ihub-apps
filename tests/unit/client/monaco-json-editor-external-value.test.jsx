// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A text the page sets from outside (Discard puts the saved object back) replaces the text
 * the admin broke. Monaco does not call `onChange` for it, so the editor must reset its own
 * parse state: it is valid again, and it tells the page.
 */
import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value, onChange }) => (
    <textarea aria-label="JSON" value={value} onChange={e => onChange(e.target.value)} />
  )
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const MonacoJsonEditor = require('../../../client/src/shared/components/MonacoJsonEditor').default;

const SAVED = { id: 'a', n: 1 };

/** A page as it holds the editor: the edited object is its state, and Discard puts SAVED back. */
function Page({ onValidationChange }) {
  const [value, setValue] = useState(SAVED);
  return (
    <>
      <MonacoJsonEditor value={value} onChange={setValue} onValidationChange={onValidationChange} />
      <button type="button" onClick={() => setValue({ ...SAVED })}>
        discard
      </button>
    </>
  );
}

describe('MonacoJsonEditor with a value set from outside', () => {
  test('is valid again, and says so, once the saved object is put back over broken text', () => {
    const onValidationChange = jest.fn();
    render(<Page onValidationChange={onValidationChange} />);

    // A valid edit, then a stray comma.
    fireEvent.change(screen.getByLabelText('JSON'), { target: { value: '{ "id": "b" }' } });
    fireEvent.change(screen.getByLabelText('JSON'), { target: { value: '{ "id": "b", }' } });
    expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
    expect(onValidationChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ isValid: false })
    );

    fireEvent.click(screen.getByRole('button', { name: 'discard' }));

    expect(screen.queryByText('Invalid JSON')).not.toBeInTheDocument();
    expect(onValidationChange).toHaveBeenLastCalledWith({ isValid: true, errors: [] });
    expect(screen.getByLabelText('JSON').value).toContain('"id": "a"');
  });

  test('does not announce anything for a text that was valid anyway', () => {
    const onValidationChange = jest.fn();
    render(<Page onValidationChange={onValidationChange} />);

    fireEvent.change(screen.getByLabelText('JSON'), { target: { value: '{ "id": "b" }' } });
    fireEvent.click(screen.getByRole('button', { name: 'discard' }));

    expect(onValidationChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('JSON').value).toContain('"id": "a"');
  });

  test('replaces broken text with the saved object even when no valid edit came first', () => {
    const onValidationChange = jest.fn();
    render(<Page onValidationChange={onValidationChange} />);

    // Broken text typed straight into the saved value: the page's object never changed.
    fireEvent.change(screen.getByLabelText('JSON'), { target: { value: '{ "id": "a", }' } });
    expect(screen.getByText('Invalid JSON')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'discard' }));

    expect(screen.queryByText('Invalid JSON')).not.toBeInTheDocument();
    expect(onValidationChange).toHaveBeenLastCalledWith({ isValid: true, errors: [] });
    expect(screen.getByLabelText('JSON').value).toContain('"id": "a"');
    expect(screen.getByLabelText('JSON').value).not.toContain('},');
  });
});
