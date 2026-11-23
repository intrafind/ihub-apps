// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One bar for the sections of a page: it shows while any section is dirty, Save runs the
 * dirty sections in order and stops at the first failure, Discard resets them all, and the
 * reason of a failed save shows in the bar.
 */
import '@testing-library/jest-dom';
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));

const {
  SaveSectionsProvider,
  SaveSectionsBar,
  useSaveSection,
  useSaveSections
} = require('../../../client/src/features/admin/components/SaveSections');

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

/** A section with one text field, saved by `onSave` (resolves true/false or throws). */
function Section({ id, saved = 'a', onSave, order }) {
  const [value, setValue] = useState(saved);
  const [savedValue, setSavedValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const { managed } = useSaveSection(id, {
    dirty: value !== savedValue,
    saving,
    error,
    save: async () => {
      setSaving(true);
      setError(null);
      try {
        order?.push(id);
        const ok = await onSave(value);
        if (ok === false) {
          setError(`${id} failed`);
          return false;
        }
        setSavedValue(value);
        return true;
      } catch (e) {
        setError(e.message);
        throw e;
      } finally {
        setSaving(false);
      }
    },
    discard: () => {
      setValue(savedValue);
      setError(null);
    }
  });
  return (
    <div>
      <input aria-label={id} value={value} onChange={e => setValue(e.target.value)} />
      <span data-testid={`${id}-managed`}>{String(managed)}</span>
    </div>
  );
}

const bar = () => screen.queryByRole('region');
const buttons = () => within(bar()).getAllByRole('button');
const discard = () => buttons()[0];
const save = () => buttons().at(-1);
const flush = () => act(async () => {});

describe('sections with one save bar', () => {
  test('no bar until a section changes; it covers every section', () => {
    render(
      <SaveSectionsProvider>
        <Section id="one" onSave={async () => true} />
        <Section id="two" onSave={async () => true} />
        <SaveSectionsBar />
      </SaveSectionsProvider>
    );
    expect(bar()).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('two'), { target: { value: 'b' } });

    expect(bar()).toBeInTheDocument();
  });

  test('Save saves only the dirty sections, in the order they registered', async () => {
    const order = [];
    const onSaveOne = jest.fn(async () => true);
    const onSaveTwo = jest.fn(async () => true);
    const onSaveThree = jest.fn(async () => true);
    render(
      <SaveSectionsProvider>
        <Section id="one" order={order} onSave={onSaveOne} />
        <Section id="two" order={order} onSave={onSaveTwo} />
        <Section id="three" order={order} onSave={onSaveThree} />
        <SaveSectionsBar />
      </SaveSectionsProvider>
    );
    fireEvent.change(screen.getByLabelText('three'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('one'), { target: { value: 'y' } });

    await act(async () => {
      fireEvent.click(save());
    });

    expect(order).toEqual(['one', 'three']);
    expect(onSaveTwo).not.toHaveBeenCalled();
    expect(onSaveOne).toHaveBeenCalledWith('y');
    expect(bar()).not.toBeInTheDocument();
  });

  test('stops at the first failure: later sections are not saved, the bar stays and says why', async () => {
    const onSaveOne = jest.fn(async () => false);
    const onSaveTwo = jest.fn(async () => true);
    render(
      <SaveSectionsProvider>
        <Section id="one" onSave={onSaveOne} />
        <Section id="two" onSave={onSaveTwo} />
        <SaveSectionsBar />
      </SaveSectionsProvider>
    );
    fireEvent.change(screen.getByLabelText('one'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('two'), { target: { value: 'y' } });

    await act(async () => {
      fireEvent.click(save());
    });

    expect(onSaveOne).toHaveBeenCalledTimes(1);
    expect(onSaveTwo).not.toHaveBeenCalled();
    expect(bar()).toBeInTheDocument();
    expect(within(bar()).getByText('one failed')).toBeInTheDocument();
  });

  test('a section that saved stays saved when a later one fails; a retry saves the rest', async () => {
    const onSaveOne = jest.fn(async () => true);
    let twoFails = true;
    const onSaveTwo = jest.fn(async () => !twoFails);
    render(
      <SaveSectionsProvider>
        <Section id="one" onSave={onSaveOne} />
        <Section id="two" onSave={onSaveTwo} />
        <SaveSectionsBar />
      </SaveSectionsProvider>
    );
    fireEvent.change(screen.getByLabelText('one'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('two'), { target: { value: 'y' } });

    await act(async () => {
      fireEvent.click(save());
    });
    expect(onSaveOne).toHaveBeenCalledTimes(1);
    expect(bar()).toBeInTheDocument();

    twoFails = false;
    await act(async () => {
      fireEvent.click(save());
    });

    // Section one was saved the first time and is not saved again.
    expect(onSaveOne).toHaveBeenCalledTimes(1);
    expect(onSaveTwo).toHaveBeenCalledTimes(2);
    expect(bar()).not.toBeInTheDocument();
  });

  test('a section that throws counts as a failure', async () => {
    const onSaveTwo = jest.fn(async () => true);
    render(
      <SaveSectionsProvider>
        <Section
          id="one"
          onSave={async () => {
            throw new Error('boom');
          }}
        />
        <Section id="two" onSave={onSaveTwo} />
        <SaveSectionsBar />
      </SaveSectionsProvider>
    );
    fireEvent.change(screen.getByLabelText('one'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('two'), { target: { value: 'y' } });

    await act(async () => {
      fireEvent.click(save());
    });

    expect(onSaveTwo).not.toHaveBeenCalled();
    expect(within(bar()).getByText('boom')).toBeInTheDocument();
  });

  test('Discard resets every dirty section and the bar goes away', () => {
    render(
      <SaveSectionsProvider>
        <Section id="one" onSave={async () => true} />
        <Section id="two" onSave={async () => true} />
        <SaveSectionsBar />
      </SaveSectionsProvider>
    );
    fireEvent.change(screen.getByLabelText('one'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('two'), { target: { value: 'y' } });

    fireEvent.click(discard());

    expect(screen.getByLabelText('one')).toHaveValue('a');
    expect(screen.getByLabelText('two')).toHaveValue('a');
    expect(bar()).not.toBeInTheDocument();
  });

  test('a section that is removed no longer holds the bar', () => {
    function Page({ showTwo }) {
      return (
        <SaveSectionsProvider>
          <Section id="one" onSave={async () => true} />
          {showTwo && <Section id="two" onSave={async () => true} />}
          <SaveSectionsBar />
        </SaveSectionsProvider>
      );
    }
    const { rerender } = render(<Page showTwo />);
    fireEvent.change(screen.getByLabelText('two'), { target: { value: 'y' } });
    expect(bar()).toBeInTheDocument();

    rerender(<Page showTwo={false} />);

    expect(bar()).not.toBeInTheDocument();
  });

  test('saving twice at once runs the sections once', async () => {
    let release;
    const onSaveOne = jest.fn(
      () =>
        new Promise(resolve => {
          release = () => resolve(true);
        })
    );
    render(
      <SaveSectionsProvider>
        <Section id="one" onSave={onSaveOne} />
        <SaveSectionsBar />
      </SaveSectionsProvider>
    );
    fireEvent.change(screen.getByLabelText('one'), { target: { value: 'x' } });

    await act(async () => {
      fireEvent.click(save());
    });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(onSaveOne).toHaveBeenCalledTimes(1);

    await act(async () => release());
    await flush();
    expect(bar()).not.toBeInTheDocument();
  });

  test('outside a provider a section is not managed and nothing breaks', () => {
    render(<Section id="alone" onSave={async () => true} />);
    expect(screen.getByTestId('alone-managed')).toHaveTextContent('false');
    fireEvent.change(screen.getByLabelText('alone'), { target: { value: 'x' } });
    expect(bar()).not.toBeInTheDocument();
  });

  test('inside a provider a section is managed: it leaves its Save to the bar', () => {
    render(
      <SaveSectionsProvider>
        <Section id="one" onSave={async () => true} />
      </SaveSectionsProvider>
    );
    expect(screen.getByTestId('one-managed')).toHaveTextContent('true');
  });

  test('useSaveSections feeds a page frame that draws the bar itself', async () => {
    function Frame() {
      const { dirty, save: saveAll, discard: discardAll } = useSaveSections();
      return (
        <div>
          <span data-testid="dirty">{String(dirty)}</span>
          <button type="button" onClick={() => void saveAll()}>
            frame save
          </button>
          <button type="button" onClick={discardAll}>
            frame discard
          </button>
        </div>
      );
    }
    const onSave = jest.fn(async () => true);
    render(
      <SaveSectionsProvider>
        <Section id="one" onSave={onSave} />
        <Frame />
      </SaveSectionsProvider>
    );
    expect(screen.getByTestId('dirty')).toHaveTextContent('false');
    fireEvent.change(screen.getByLabelText('one'), { target: { value: 'x' } });
    expect(screen.getByTestId('dirty')).toHaveTextContent('true');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'frame save' }));
    });

    expect(onSave).toHaveBeenCalledWith('x');
    expect(screen.getByTestId('dirty')).toHaveTextContent('false');
  });
});
