// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { StrictMode, useRef, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useFocusTrap } from '../../../client/src/shared/hooks/useFocusTrap';

function Dialog({ onClose }) {
  const containerRef = useRef(null);
  const searchRef = useRef(null);
  useFocusTrap(containerRef, { isActive: true, initialFocusRef: searchRef });
  return (
    <div ref={containerRef} role="dialog" aria-modal="true">
      <button type="button">First button</button>
      <input ref={searchRef} aria-label="Search apps" />
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function Page() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Copy an existing app
      </button>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </>
  );
}

const flush = () => act(async () => {});

describe('useFocusTrap under React StrictMode', () => {
  test('the initial field keeps the focus after the effects run twice', async () => {
    render(
      <StrictMode>
        <Page />
      </StrictMode>
    );
    const opener = screen.getByRole('button', { name: 'Copy an existing app' });
    opener.focus();
    fireEvent.click(opener);
    await flush();
    expect(screen.getByRole('textbox', { name: 'Search apps' })).toHaveFocus();
  });

  test('closing returns the focus to the button that opened the dialog', async () => {
    render(
      <StrictMode>
        <Page />
      </StrictMode>
    );
    const opener = screen.getByRole('button', { name: 'Copy an existing app' });
    opener.focus();
    fireEvent.click(opener);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await flush();
    expect(opener).toHaveFocus();
  });
});
