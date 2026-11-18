// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * useConfirmAction:
 *   - an action still running when a newer confirmation is requested does not
 *     close that confirmation or show its error there;
 *   - `focusAfterSuccess` moves focus to a stable element once the action
 *     succeeded (the trigger is gone after a delete); Cancel and a failure
 *     return focus to the trigger as before.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';

jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const { useConfirmAction } = require('../../../client/src/features/admin/hooks/useConfirmAction');
const ConfirmDialog = require('../../../client/src/shared/components/ConfirmDialog').default;

/** Lets the focus trap's queued focus restoration run. */
const flush = () => act(async () => {});

/** A deferred promise the test settles by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('a newer confirmation is not touched by an older running action', () => {
  function Harness({ actionA, actionB }) {
    const { requestConfirm, dialogProps } = useConfirmAction();
    return (
      <>
        <button
          type="button"
          onClick={() =>
            requestConfirm({
              title: 'Delete A?',
              confirmLabel: 'Delete',
              errorMessage: () => 'A failed',
              action: actionA
            })
          }
        >
          Ask A
        </button>
        <button
          type="button"
          onClick={() =>
            requestConfirm({ title: 'Delete B?', confirmLabel: 'Delete', action: actionB })
          }
        >
          Ask B
        </button>
        <ConfirmDialog {...dialogProps} />
      </>
    );
  }

  /** Confirms A, then (while A runs) requests B straight through the hook. */
  async function startAThenAskB(actionA) {
    const actionB = jest.fn();
    const utils = render(<Harness actionA={actionA} actionB={actionB} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask A' }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
      );
    });
    // The busy dialog blocks the page; a newer request still comes in from code.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ask B', hidden: true }));
    });
    expect(screen.getByRole('alertdialog', { name: 'Delete B?' })).toBeInTheDocument();
    return { ...utils, actionB };
  }

  it('A succeeding later does not close B', async () => {
    const a = deferred();
    const { unmount } = await startAThenAskB(() => a.promise);
    await act(async () => {
      a.resolve();
    });
    expect(screen.getByRole('alertdialog', { name: 'Delete B?' })).toBeInTheDocument();
    unmount();
    await flush();
  });

  it('A failing later shows no error in B', async () => {
    const a = deferred();
    const { unmount } = await startAThenAskB(() => a.promise);
    await act(async () => {
      a.reject(new Error('boom'));
    });
    const dialogB = screen.getByRole('alertdialog', { name: 'Delete B?' });
    expect(within(dialogB).queryByRole('alert')).not.toBeInTheDocument();
    expect(dialogB).not.toHaveTextContent('A failed');
    unmount();
    await flush();
  });
});

describe('focusAfterSuccess', () => {
  /** A list whose rows are deleted through a confirmation; the heading takes focus. */
  function DeletableList({ action }) {
    const [items, setItems] = useState(['alpha', 'beta']);
    const headingRef = useRef(null);
    const { requestConfirm, dialogProps } = useConfirmAction();
    const remove = item =>
      requestConfirm({
        title: `Delete "${item}"?`,
        confirmLabel: 'Delete',
        errorMessage: () => 'Delete failed',
        action: async () => {
          await action(item);
          setItems(prev => prev.filter(other => other !== item));
        },
        focusAfterSuccess: headingRef
      });
    return (
      <>
        <h1 ref={headingRef} tabIndex={-1}>
          Items
        </h1>
        <ul>
          {items.map(item => (
            <li key={item}>
              <button type="button" onClick={() => remove(item)}>
                {`Delete ${item}`}
              </button>
            </li>
          ))}
        </ul>
        <ConfirmDialog {...dialogProps} />
      </>
    );
  }

  async function openAndConfirm(action) {
    const utils = render(<DeletableList action={action} />);
    const trigger = screen.getByRole('button', { name: 'Delete alpha' });
    trigger.focus();
    fireEvent.click(trigger);
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
      );
    });
    await flush();
    return { ...utils, trigger };
  }

  it('moves focus to the given element after the action succeeded', async () => {
    const { unmount } = await openAndConfirm(jest.fn().mockResolvedValue());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete alpha' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Items' })).toHaveFocus();
    unmount();
  });

  it('keeps the dialog open and focus inside it when the action fails', async () => {
    const { unmount } = await openAndConfirm(jest.fn().mockRejectedValue(new Error('no')));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Delete failed');
    expect(screen.getByRole('heading', { name: 'Items' })).not.toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    unmount();
    await flush();
  });

  it('Cancel returns focus to the trigger', async () => {
    const { unmount } = render(<DeletableList action={jest.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Delete alpha' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' })
    );
    await flush();
    expect(trigger).toHaveFocus();
    unmount();
  });
});
