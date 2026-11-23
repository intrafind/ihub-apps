// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The icon list closes when the keyboard focus leaves the picker. Left open,
 * it lies over the control that is focused next, and Escape cannot close it
 * from there.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));
// Icon uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const IconPicker = require('../../../client/src/shared/components/IconPicker').default;

function Field({ onChange = () => {} }) {
  return (
    <>
      <IconPicker id="icon" value="star" onChange={onChange} />
      <button type="button">Next control</button>
    </>
  );
}

const trigger = () => document.getElementById('icon');
const search = () => screen.queryByRole('textbox');

function openPicker() {
  trigger().focus();
  fireEvent.click(trigger());
  expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  act(() => search().focus());
}

describe('IconPicker and the keyboard focus', () => {
  it('closes the list when the focus moves to a control outside, and leaves the focus there', () => {
    render(<Field />);
    openPicker();
    fireEvent.change(search(), { target: { value: 'chat' } });

    const next = screen.getByRole('button', { name: 'Next control' });
    act(() => next.focus());
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(search()).not.toBeInTheDocument();
    expect(document.activeElement).toBe(next);

    // Opened again, the search starts empty.
    openPicker();
    expect(search()).toHaveValue('');
  });

  it('stays open while the focus moves inside the picker', () => {
    render(<Field />);
    openPicker();
    act(() => trigger().focus());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    act(() => search().focus());
    expect(search()).toBeInTheDocument();
  });

  it('a blur without a next element does not close it, so a click on an icon still picks', () => {
    const onChange = jest.fn();
    render(<Field onChange={onChange} />);
    openPicker();
    // Safari does not focus a clicked button: the search field blurs to nothing.
    fireEvent.blur(search(), { relatedTarget: null });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'user' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });
});
