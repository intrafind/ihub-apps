// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `useOverlayPanel`: the keyboard behaviour of the admin test panels (app,
 * integration, project), which sit beside the page from `lg` up and cover it
 * below.
 *
 *   - covering the page it is a dialog: focus moves to the close button, Escape
 *     closes it, and focus goes back to the element that opened it;
 *   - beside the page it is a plain panel: no dialog role, no focus taken,
 *     Escape left alone;
 *   - growing the window past the breakpoint while it is open turns the
 *     dialog off and gives focus back.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import useOverlayPanel, {
  PANEL_BESIDE_PAGE_QUERY
} from '../../../client/src/shared/hooks/useOverlayPanel';

function Panel({ onClose }) {
  const { panelRef, closeRef, dialogProps, overlay } = useOverlayPanel({ onClose });
  return (
    <aside ref={panelRef} aria-label="Panel" data-overlay={String(overlay)} {...dialogProps}>
      <button type="button" ref={closeRef} onClick={onClose}>
        Close
      </button>
      <button type="button">Other</button>
    </aside>
  );
}

const original = window.matchMedia;
let changeListeners;

/** A matchMedia that answers `matches` for the breakpoint and lets a test change it. */
function mockViewport({ wide }) {
  changeListeners = new Set();
  window.matchMedia = query => ({
    matches: query === PANEL_BESIDE_PAGE_QUERY ? wide : false,
    addEventListener: (_type, listener) => changeListeners.add(listener),
    removeEventListener: (_type, listener) => changeListeners.delete(listener)
  });
}

function resizeTo({ wide }) {
  act(() => {
    changeListeners.forEach(listener => listener({ matches: wide }));
  });
}

function renderPanelWithOpener() {
  const opener = document.createElement('button');
  opener.textContent = 'Open';
  document.body.appendChild(opener);
  opener.focus();
  const onClose = jest.fn();
  const utils = render(<Panel onClose={onClose} />);
  return { opener, onClose, ...utils };
}

afterEach(() => {
  window.matchMedia = original;
  document.body.querySelectorAll(':scope > button').forEach(el => el.remove());
});

describe('covering the page (below lg)', () => {
  beforeEach(() => mockViewport({ wide: false }));

  test('is a dialog and moves focus to the close button', () => {
    renderPanelWithOpener();
    const panel = screen.getByLabelText('Panel');
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(panel).toHaveAttribute('data-overlay', 'true');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  test('closes on Escape, and only on Escape', () => {
    const { onClose } = renderPanelWithOpener();
    const panel = screen.getByLabelText('Panel');
    fireEvent.keyDown(panel, { key: 'Enter' });
    fireEvent.keyDown(panel, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('closes on Escape pressed in an element inside the panel', () => {
    const { onClose } = renderPanelWithOpener();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Other' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('gives focus back to the opener when it goes away', async () => {
    const { opener, unmount } = renderPanelWithOpener();
    expect(opener).not.toHaveFocus();
    unmount();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  test('stops listening for Escape once it is gone', () => {
    const { onClose, unmount } = renderPanelWithOpener();
    const panel = screen.getByLabelText('Panel');
    unmount();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  test('uses the latest onClose', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(<Panel onClose={first} />);
    rerender(<Panel onClose={second} />);
    fireEvent.keyDown(screen.getByLabelText('Panel'), { key: 'Escape' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('beside the page (from lg up)', () => {
  beforeEach(() => mockViewport({ wide: true }));

  test('is a plain panel: no dialog, no focus taken, Escape left alone', () => {
    const { opener, onClose } = renderPanelWithOpener();
    const panel = screen.getByLabelText('Panel');
    expect(panel).not.toHaveAttribute('role');
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(panel).toHaveAttribute('data-overlay', 'false');
    expect(opener).toHaveFocus();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('crossing the breakpoint while open', () => {
  test('growing past it turns the dialog off and gives focus back', async () => {
    mockViewport({ wide: false });
    const { opener, onClose } = renderPanelWithOpener();
    const panel = screen.getByLabelText('Panel');
    expect(panel).toHaveAttribute('role', 'dialog');

    resizeTo({ wide: true });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(panel).not.toHaveAttribute('role');
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  test('shrinking below it makes it a dialog', () => {
    mockViewport({ wide: true });
    renderPanelWithOpener();
    const panel = screen.getByLabelText('Panel');
    expect(panel).not.toHaveAttribute('role');

    resizeTo({ wide: false });
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});
