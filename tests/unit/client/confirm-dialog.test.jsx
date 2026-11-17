// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ConfirmDialog v2 (named confirmations) and the shared overlay stack:
 *   - the dialog is an alertdialog named by its title, described by its message;
 *   - focus starts on Cancel (or on the type-to-confirm field), Escape cancels;
 *   - type-to-confirm enables the confirm button only on an exact (trimmed,
 *     case-sensitive) match, typed or pasted;
 *   - busy, error and blocked states;
 *   - two open dialogs get distinct ids (UX-N3);
 *   - Escape closes only the topmost overlay (UX-N2), and a dirty Modal asks
 *     before discarding (IN-B12).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useState } from 'react';

jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});
// Icon pulls in runtimeBasePath (import.meta), which jest can't load.
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const ConfirmDialog = require('../../../client/src/shared/components/ConfirmDialog').default;
const Modal = require('../../../client/src/shared/components/Modal').default;
const { getOpenOverlayCount } = require('../../../client/src/shared/hooks/useOverlayStack');

/** Lets the focus trap's queued focus restoration run. */
const flush = () => act(async () => {});

function renderDialog(props = {}) {
  const onConfirm = jest.fn();
  const onDeny = jest.fn();
  const utils = render(
    <ConfirmDialog
      isOpen
      title='Delete model "GPT-4o"?'
      message="The model is removed for all users."
      confirmLabel="Delete"
      danger
      onConfirm={onConfirm}
      onDeny={onDeny}
      {...props}
    />
  );
  return { ...utils, onConfirm, onDeny };
}

afterEach(() => {
  expect(getOpenOverlayCount()).toBe(0);
});

describe('ConfirmDialog', () => {
  it('is an alertdialog named by the title and described by the message', () => {
    const { unmount } = renderDialog();
    const dialog = screen.getByRole('alertdialog', { name: 'Delete model "GPT-4o"?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('The model is removed for all users.');
    unmount();
  });

  it('puts focus on Cancel first and names the confirm button with the verb', () => {
    const { unmount } = renderDialog();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    unmount();
  });

  it('cancels on Escape and on the backdrop, and confirms on the verb button', () => {
    const { onConfirm, onDeny, unmount } = renderDialog();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDeny).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('takes focus back when the menu that opened it returns focus to its trigger', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const { unmount } = renderDialog();
    // The menu closes after the dialog opened and focuses its own trigger.
    trigger.focus();
    expect(trigger).toHaveFocus();
    await act(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    unmount();
    trigger.remove();
  });

  it('leaves focus where the confirmed action put it, even before the next frame', async () => {
    // The action of a delete moves focus to the page heading (the row is gone)
    // before the dialog closes. The open-time refocus frame must not pull it back.
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    document.body.appendChild(heading);
    const onConfirm = jest.fn(() => heading.focus());
    const { unmount } = renderDialog({ onConfirm });
    // Confirm within the first frame after opening.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(heading).toHaveFocus();
    await act(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
    expect(heading).toHaveFocus();
    unmount();
    heading.remove();
  });

  it('lists consequences and the irreversible callout', () => {
    const { unmount } = renderDialog({
      consequences: ['Used by "HR assistant"', 'Used by "Sales bot"'],
      irreversible: true
    });
    const items = screen.getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toEqual([
      'Used by "HR assistant"',
      'Used by "Sales bot"'
    ]);
    expect(screen.getByText("This can't be undone.")).toBeInTheDocument();
    unmount();
  });

  describe('type-to-confirm', () => {
    const token = 'ihub.example.com:3000';

    it('focuses the field and keeps confirm disabled until the exact token is typed', () => {
      const { onConfirm, unmount } = renderDialog({ typedConfirmation: { token } });
      const field = screen.getByRole('textbox', { name: /To confirm, type/ });
      expect(field).toHaveFocus();
      expect(field).toHaveAccessibleName(`To confirm, type ${token}`);
      const confirm = screen.getByRole('button', { name: 'Delete' });

      expect(confirm).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(confirm);
      expect(onConfirm).not.toHaveBeenCalled();

      // Case matters: a token that differs only in case does not match.
      fireEvent.change(field, { target: { value: token.toUpperCase() } });
      fireEvent.click(confirm);
      expect(onConfirm).not.toHaveBeenCalled();

      fireEvent.change(field, { target: { value: 'ihub.example.com' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onConfirm).not.toHaveBeenCalled();

      // Surrounding whitespace is ignored.
      fireEvent.change(field, { target: { value: `  ${token} ` } });
      expect(confirm).not.toHaveAttribute('aria-disabled');
      fireEvent.click(confirm);
      expect(onConfirm).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('accepts a pasted token and submits with Enter', () => {
      const { onConfirm, unmount } = renderDialog({ typedConfirmation: { token } });
      const field = screen.getByRole('textbox');
      fireEvent.paste(field, { clipboardData: { getData: () => token } });
      fireEvent.change(field, { target: { value: token } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onConfirm).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('shows the token in a code chip with a copy button', async () => {
      const writeText = jest.fn().mockResolvedValue();
      Object.assign(navigator, { clipboard: { writeText } });
      const { unmount } = renderDialog({ typedConfirmation: { token } });
      expect(screen.getByText(token).tagName).toBe('CODE');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      });
      expect(writeText).toHaveBeenCalledWith(token);
      unmount();
    });

    it('starts empty when the dialog is opened again', () => {
      const props = {
        title: 'Delete registry "ihub-official"?',
        confirmLabel: 'Delete',
        typedConfirmation: { token: 'ihub-official' },
        onConfirm: () => {},
        onDeny: () => {}
      };
      const { rerender, unmount } = render(<ConfirmDialog isOpen {...props} />);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ihub-official' } });
      rerender(<ConfirmDialog isOpen={false} {...props} />);
      rerender(<ConfirmDialog isOpen {...props} />);
      expect(screen.getByRole('textbox')).toHaveValue('');
      unmount();
    });
  });

  it('while busy: spinner state, both buttons inert, Escape and backdrop ignored', () => {
    const { onConfirm, onDeny, unmount } = renderDialog({ busy: true });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Working…');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
    unmount();
  });

  it('shows an error inline and stays open', () => {
    const { unmount } = renderDialog({ error: 'Provider "openai" is used by 3 models.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Provider "openai" is used by 3 models.');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    unmount();
  });

  it('blocked: shows the reason and only a Close button', () => {
    const { onDeny, unmount } = renderDialog({
      blocked: { reason: 'All 9 apps are already enabled.' },
      message: 'ignored'
    });
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(
      'All 9 apps are already enabled.'
    );
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    expect(onDeny).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('gives two open dialogs distinct ids and names (UX-N3)', () => {
    const { unmount } = render(
      <>
        <ConfirmDialog
          isOpen
          title="Leave without saving?"
          message="Your changes will be lost."
          onConfirm={() => {}}
          onDeny={() => {}}
        />
        <ConfirmDialog
          isOpen
          title='Delete group "sales"?'
          message="Members lose its permissions."
          onConfirm={() => {}}
          onDeny={() => {}}
        />
      </>
    );
    const [first, second] = screen.getAllByRole('alertdialog');
    expect(first.getAttribute('aria-labelledby')).not.toBe(second.getAttribute('aria-labelledby'));
    expect(first).toHaveAccessibleName('Leave without saving?');
    expect(second).toHaveAccessibleName('Delete group "sales"?');
    const ids = Array.from(document.querySelectorAll('[id]')).map(el => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    unmount();
  });
});

describe('overlay stack: Escape closes only the topmost overlay (UX-N2)', () => {
  function ModalWithConfirm({ onModalClose }) {
    const [confirmOpen, setConfirmOpen] = useState(false);
    return (
      <Modal isOpen onClose={onModalClose} labelledBy="m-title">
        <h2 id="m-title">Connected users</h2>
        <button type="button" onClick={() => setConfirmOpen(true)}>
          Disconnect
        </button>
        <ConfirmDialog
          isOpen={confirmOpen}
          title='Disconnect "alice"?'
          confirmLabel="Disconnect"
          onConfirm={() => setConfirmOpen(false)}
          onDeny={() => setConfirmOpen(false)}
        />
      </Modal>
    );
  }

  it('a confirmation over a modal: the first Escape closes the confirmation only', async () => {
    const onModalClose = jest.fn();
    const { unmount } = render(<ModalWithConfirm onModalClose={onModalClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(getOpenOverlayCount()).toBe(2);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onModalClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Now the modal is the topmost overlay.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onModalClose).toHaveBeenCalledTimes(1);
    await flush();
    unmount();
  });

  it('a modal and a confirmation inside it that open in the same render: Escape goes to the confirmation', async () => {
    // React runs the child's layout effect first, so the confirmation used to
    // register below its modal, and Escape closed the modal.
    const onModalClose = jest.fn();
    const onDeny = jest.fn();
    const { unmount } = render(
      <Modal isOpen onClose={onModalClose} labelledBy="m2-title">
        <h2 id="m2-title">Connected users</h2>
        <ConfirmDialog
          isOpen
          title='Disconnect "alice"?'
          confirmLabel="Disconnect"
          onConfirm={jest.fn()}
          onDeny={onDeny}
        />
      </Modal>
    );
    expect(getOpenOverlayCount()).toBe(2);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onModalClose).not.toHaveBeenCalled();
    unmount();
    await flush();
  });

  it('an overlay opened later outside the modal goes on top of it', async () => {
    const onModalClose = jest.fn();
    const onDeny = jest.fn();
    function Page({ confirmOpen }) {
      return (
        <>
          <Modal isOpen onClose={onModalClose} labelledBy="m3-title">
            <h2 id="m3-title">Settings</h2>
          </Modal>
          <ConfirmDialog
            isOpen={confirmOpen}
            title="Rotate the secret?"
            confirmLabel="Rotate"
            onConfirm={jest.fn()}
            onDeny={onDeny}
          />
        </>
      );
    }
    const { rerender, unmount } = render(<Page confirmOpen={false} />);
    rerender(<Page confirmOpen />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onModalClose).not.toHaveBeenCalled();
    unmount();
    await flush();
  });
});

describe('Modal isDirty (IN-B12)', () => {
  function DirtyModal({ isDirty, onClose }) {
    return (
      <Modal
        isOpen
        onClose={onClose}
        isDirty={isDirty}
        dirtyTitle="Install integration"
        labelledBy="d-title"
      >
        {({ requestClose }) => (
          <>
            <h2 id="d-title">Install integration</h2>
            <button type="button" aria-label="Close" onClick={requestClose}>
              ✕
            </button>
          </>
        )}
      </Modal>
    );
  }

  const backdrop = () => document.querySelector('[aria-hidden="true"].fixed.inset-0');

  it('clean: Escape, ✕ and the backdrop close as before', () => {
    const onClose = jest.fn();
    const { unmount } = render(<DirtyModal isDirty={false} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(backdrop());
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    unmount();
  });

  it('dirty: the backdrop does nothing; Escape and ✕ ask before discarding', () => {
    const onClose = jest.fn();
    const { unmount } = render(<DirtyModal isDirty onClose={onClose} />);

    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    const ask = screen.getByRole('alertdialog', { name: 'Discard changes?' });
    expect(ask).toHaveTextContent('What you entered in "Install integration" will be lost.');
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();

    // Escape on the question keeps editing; the modal stays open.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('a question pending when the modal turned clean does not come back when it is dirty again', async () => {
    const onClose = jest.fn();
    const { rerender, unmount } = render(<DirtyModal isDirty onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: 'Discard changes?' })).toBeInTheDocument();

    rerender(<DirtyModal isDirty={false} onClose={onClose} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    rerender(<DirtyModal isDirty onClose={onClose} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    unmount();
    await flush();
  });

  it('the discard question stacks on the layer of a raised modal', async () => {
    const { unmount } = render(
      <Modal isOpen onClose={jest.fn()} isDirty zIndexClassName="z-[70]" labelledBy="r-title">
        {({ requestClose }) => (
          <>
            <h2 id="r-title">Share artifact</h2>
            <button type="button" aria-label="Close" onClick={requestClose}>
              ✕
            </button>
          </>
        )}
      </Modal>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const layer = screen.getByRole('alertdialog').closest('[role="presentation"]');
    expect(layer).toHaveClass('z-[70]');
    expect(layer).not.toHaveClass('z-50');
    unmount();
    await flush();
  });
});
