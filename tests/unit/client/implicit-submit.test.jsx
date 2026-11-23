// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A form whose Save is the bottom bar outside it keeps Enter-to-save through a hidden submit
 * button: the form's first submit button is the default button a browser presses on Enter.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

const ImplicitSubmit = require('../../../client/src/shared/components/ImplicitSubmit').default;

function Form({ saving = false, onSubmit }) {
  return (
    <form onSubmit={onSubmit} aria-label="the form">
      <ImplicitSubmit disabled={saving} />
      <input aria-label="name" />
      <input aria-label="id" />
      <button type="button">Add</button>
    </form>
  );
}

describe('ImplicitSubmit', () => {
  test('is the first submit button of the form, so Enter in a field presses it', () => {
    render(<Form />);
    const form = screen.getByRole('form', { name: 'the form' });
    const firstSubmit = form.querySelector('button[type="submit"]');
    expect(firstSubmit).toBe(screen.getByTestId('implicit-submit'));
    expect(firstSubmit).toBeEnabled();
  });

  test('pressing it submits the form', () => {
    const onSubmit = jest.fn(e => e.preventDefault());
    render(<Form onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId('implicit-submit'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('is disabled while a save runs, so Enter cannot save twice', () => {
    render(<Form saving />);
    expect(screen.getByTestId('implicit-submit')).toBeDisabled();
  });

  test('is not seen, announced or reachable with Tab', () => {
    render(<Form />);
    const button = screen.getByTestId('implicit-submit');
    expect(button).toHaveAttribute('aria-hidden', 'true');
    expect(button).toHaveAttribute('tabindex', '-1');
    expect(button).toHaveClass('sr-only');
    // Not in the accessibility tree: the page keeps one Save, the bar's.
    expect(screen.queryByRole('button', { name: '' })).not.toBeInTheDocument();
  });
});
