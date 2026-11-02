// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shared Drawer: a modal dialog named by its title that takes focus on
 * open, keeps Tab inside, closes on Escape and the backdrop, gives focus back
 * to the element that opened it, and locks the page scroll meanwhile.
 */
import { useRef, useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import Drawer from '../../../client/src/shared/components/Drawer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

// jsdom has no layout: every element has no size and no offsetParent, which
// the focus trap reads as "not rendered". Give elements a box, as a browser
// would, so the trap sees the drawer's buttons.
const layoutProps = ['offsetWidth', 'offsetHeight', 'offsetParent'];
const originals = {};
beforeAll(() => {
  for (const prop of layoutProps) {
    originals[prop] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 100
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 20
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.parentNode;
    }
  });
});
afterAll(() => {
  for (const prop of layoutProps) {
    if (originals[prop]) Object.defineProperty(HTMLElement.prototype, prop, originals[prop]);
  }
});

/** A page with a button that opens the drawer, as the admin pages have. */
function Page({ drawerProps = {}, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        History
      </button>
      <Drawer
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Change History"
        description="Every saved change"
        {...drawerProps}
      >
        {children || (
          <>
            <button type="button">First snapshot</button>
            <button type="button">Second snapshot</button>
          </>
        )}
      </Drawer>
    </div>
  );
}

/** Lets the focus trap's queued focus restore run. */
const flushMicrotasks = () => act(() => Promise.resolve());

describe('Drawer', () => {
  it('is hidden and inert while closed', () => {
    render(<Page />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const root = document.body.querySelector('[inert]');
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute('aria-hidden', 'true');
  });

  it('opens as a modal dialog named by its title and described by its description', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'History' }));

    const dialog = screen.getByRole('dialog', { name: 'Change History' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Every saved change');
    expect(screen.getByRole('heading', { level: 2, name: 'Change History' })).toBeInTheDocument();
    expect(document.body.querySelector('[inert]')).toBeNull();
  });

  it('is full width on phones and its size from the sm breakpoint up', async () => {
    const user = userEvent.setup();
    render(<Page drawerProps={{ size: 'lg' }} />);
    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByRole('dialog')).toHaveClass('w-full', 'max-w-full', 'sm:w-[42rem]');
  });

  it('moves focus into the drawer and keeps Tab and Shift+Tab inside it', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'History' }));

    const close = screen.getByRole('button', { name: 'Close' });
    const first = screen.getByRole('button', { name: 'First snapshot' });
    const last = screen.getByRole('button', { name: 'Second snapshot' });
    expect(close).toHaveFocus();

    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    expect(last).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('focuses the element named by initialFocusRef', async () => {
    function WithInitialFocus() {
      const ref = useRef(null);
      return (
        <Page drawerProps={{ initialFocusRef: ref }}>
          <button type="button">Other</button>
          <button type="button" ref={ref}>
            Preferred
          </button>
        </Page>
      );
    }
    const user = userEvent.setup();
    render(<WithInitialFocus />);
    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByRole('button', { name: 'Preferred' })).toHaveFocus();
  });

  it('brings focus back inside when the focused element disappears', async () => {
    function Disappearing() {
      const [shown, setShown] = useState(true);
      return (
        <Page>
          {shown && (
            <button type="button" onClick={() => setShown(false)}>
              Back to list
            </button>
          )}
          <button type="button">Snapshot</button>
        </Page>
      );
    }
    const user = userEvent.setup();
    render(<Disappearing />);
    await user.click(screen.getByRole('button', { name: 'History' }));
    await user.click(screen.getByRole('button', { name: 'Back to list' }));
    expect(screen.getByRole('dialog')).not.toContainElement(document.activeElement);

    await user.tab();
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('closes on Escape and gives focus back to the button that opened it', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const opener = screen.getByRole('button', { name: 'History' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    await flushMicrotasks();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes with its close button and on a backdrop click', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'History' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'History' }));
    const backdrop = screen.getByRole('dialog').previousElementSibling;
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('can keep Escape and the backdrop from closing it', async () => {
    const user = userEvent.setup();
    render(<Page drawerProps={{ closeOnEscape: false, closeOnBackdropClick: false }} />);
    await user.click(screen.getByRole('button', { name: 'History' }));
    await user.keyboard('{Escape}');
    fireEvent.click(screen.getByRole('dialog').previousElementSibling);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('leaves Escape to a dialog stacked on top of it', async () => {
    const onClose = jest.fn();
    render(
      <>
        <Drawer isOpen onClose={onClose} title="Change History">
          <p>Snapshots</p>
        </Drawer>
        <div role="alertdialog" aria-modal="true" aria-label="Confirm rollback">
          <button type="button">Cancel</button>
        </div>
      </>
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks the page scroll while open and restores it on close', async () => {
    const user = userEvent.setup();
    document.body.style.overflow = 'auto';
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = '';
  });

  it('renders a subheader and a footer around the scrolling body', async () => {
    const user = userEvent.setup();
    render(
      <Page
        drawerProps={{
          subheader: <p>apps / chat</p>,
          footer: <button type="button">Done</button>,
          icon: <svg data-testid="clock" />,
          closeLabel: 'Close history'
        }}
      >
        <p>Body</p>
      </Page>
    );
    await user.click(screen.getByRole('button', { name: 'History' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/apps \/ chat.*Body.*Done/);
    expect(screen.getByTestId('clock').parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Close history' })).toBeInTheDocument();
  });
});
