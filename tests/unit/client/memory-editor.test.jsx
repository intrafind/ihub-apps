import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import MemoryEditor, {
  isVersionConflict
} from '../../../client/src/shared/components/MemoryEditor';

/**
 * The editor that agent memory (admin) and scheduled-task memory (owner) share.
 * It holds unsaved text while its page re-renders and polls, reports a stale
 * save as a conflict whichever shape the API reports it in, and tells the user
 * when the notes changed underneath an edit instead of overwriting either side.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) => {
      if (typeof fallback !== 'string') return key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
    },
    i18n: { language: 'en' }
  })
}));

const DOC = { body: 'Reported up to v1.2.0\n', version: 3, updatedAt: '2026-10-07T07:00:00Z' };

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setup(overrides = {}) {
  const props = {
    id: 'task-1',
    load: jest.fn().mockResolvedValue(DOC),
    save: jest.fn().mockResolvedValue({ version: 4 }),
    ...overrides
  };
  const utils = render(<MemoryEditor {...props} />);
  return { props, ...utils };
}

const textarea = () => screen.getByRole('textbox', { name: 'Memory notes' });

describe('MemoryEditor', () => {
  it('loads the notes and shows version and update time', async () => {
    setup();
    await flush();
    expect(textarea()).toHaveValue(DOC.body);
    expect(screen.getByTestId('memory-version')).toHaveTextContent(
      'Version 3 · updated 2026-10-07T07:00:00Z'
    );
  });

  it('shows who wrote the notes when it is known', async () => {
    setup({ load: jest.fn().mockResolvedValue({ ...DOC, updatedBy: 'compose:r1' }) });
    await flush();
    expect(screen.getByTestId('memory-version')).toHaveTextContent('by compose:r1');
  });

  it('saves with the loaded version and then continues from the version it got back', async () => {
    const { props } = setup();
    await flush();
    fireEvent.change(textarea(), { target: { value: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    expect(props.save).toHaveBeenCalledWith({ content: 'edited', expectedVersion: 3 });
    expect(screen.getByTestId('memory-version')).toHaveTextContent('Version 4');

    fireEvent.change(textarea(), { target: { value: 'edited again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    expect(props.save).toHaveBeenLastCalledWith({ content: 'edited again', expectedVersion: 4 });
  });

  it('does not offer to save text that has not changed', async () => {
    setup();
    await flush();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('turns a conflict into a message with a reload that discards the edit', async () => {
    const conflict = Object.assign(new Error('x'), {
      response: { data: { error: 'VERSION_CONFLICT', currentVersion: 5 } }
    });
    const load = jest
      .fn()
      .mockResolvedValueOnce(DOC)
      .mockResolvedValueOnce({ body: 'someone else wrote this', version: 5 });
    setup({ load, save: jest.fn().mockRejectedValue(conflict) });
    await flush();
    fireEvent.change(textarea(), { target: { value: 'my edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Conflict: memory was modified elsewhere');
    // The edit is still there until the user decides.
    expect(textarea()).toHaveValue('my edit');

    fireEvent.click(screen.getByRole('button', { name: 'Reload (discard my edits)' }));
    await flush();
    expect(textarea()).toHaveValue('someone else wrote this');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows other save errors through formatError without offering a reload', async () => {
    setup({
      save: jest.fn().mockRejectedValue(new Error('storage is down')),
      formatError: err => `Could not save: ${err.message}`
    });
    await flush();
    fireEvent.change(textarea(), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save: storage is down');
    expect(screen.queryByRole('button', { name: /Reload/ })).not.toBeInTheDocument();
  });

  it('reloads silently when reloadKey changes and nothing was edited', async () => {
    const load = jest
      .fn()
      .mockResolvedValueOnce(DOC)
      .mockResolvedValueOnce({ body: 'written by a run', version: 4 });
    const { props, rerender } = setup({ load, reloadKey: 1 });
    await flush();
    rerender(<MemoryEditor {...props} reloadKey={2} />);
    await flush();
    expect(textarea()).toHaveValue('written by a run');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps unsaved text when reloadKey changes and offers the choice', async () => {
    const load = jest
      .fn()
      .mockResolvedValueOnce(DOC)
      .mockResolvedValueOnce({ body: 'written by a run', version: 4 });
    const { props, rerender } = setup({ load, reloadKey: 1 });
    await flush();
    fireEvent.change(textarea(), { target: { value: 'my unsaved text' } });
    rerender(<MemoryEditor {...props} reloadKey={2} />);
    await flush();

    expect(textarea()).toHaveValue('my unsaved text');
    expect(screen.getByRole('status')).toHaveTextContent('The notes changed');

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(textarea()).toHaveValue('my unsaved text');
  });

  it('keeps text typed while an automatic reload is still loading', async () => {
    let finishReload;
    const load = jest
      .fn()
      .mockResolvedValueOnce(DOC)
      .mockReturnValueOnce(
        new Promise(resolve => {
          finishReload = resolve;
        })
      );
    const { props, rerender } = setup({ load, reloadKey: 1 });
    await flush();

    // Nothing was edited when the key changed, so the reload starts silently ...
    rerender(<MemoryEditor {...props} reloadKey={2} />);
    await flush();
    // ... and the user types before it answers.
    fireEvent.change(textarea(), { target: { value: 'typed while loading' } });
    await act(async () => {
      finishReload({ body: 'written by a run', version: 4 });
    });

    expect(textarea()).toHaveValue('typed while loading');
    expect(screen.getByRole('status')).toHaveTextContent('The notes changed');
  });

  describe('when the editor moves to other notes while an operation is running', () => {
    const DOC_B = { body: 'notes of B\n', version: 7, updatedAt: '2026-10-07T08:00:00Z' };

    it('a late save of the first notes does not touch the second', async () => {
      let finishSave;
      const save = jest.fn().mockReturnValue(
        new Promise(resolve => {
          finishSave = resolve;
        })
      );
      const onSaved = jest.fn();
      const { props, rerender } = setup({ id: 'a', save, onSaved });
      await flush();
      fireEvent.change(textarea(), { target: { value: 'edited A' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await flush();

      rerender(
        <MemoryEditor
          {...props}
          id="b"
          load={jest.fn().mockResolvedValue(DOC_B)}
          onSaved={onSaved}
        />
      );
      await flush();
      expect(textarea()).toHaveValue(DOC_B.body);

      await act(async () => {
        finishSave({ version: 4 });
      });
      expect(textarea()).toHaveValue(DOC_B.body);
      expect(screen.getByTestId('memory-version')).toHaveTextContent('Version 7');
      expect(onSaved).not.toHaveBeenCalled();
      // B is not stuck in "saving" and can be saved on its own version.
      fireEvent.change(textarea(), { target: { value: 'edited B' } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('a late failure of the first notes shows no error on the second', async () => {
      let failSave;
      const save = jest.fn().mockReturnValue(
        new Promise((_, reject) => {
          failSave = reject;
        })
      );
      const { props, rerender } = setup({ id: 'a', save });
      await flush();
      fireEvent.change(textarea(), { target: { value: 'edited A' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await flush();
      rerender(<MemoryEditor {...props} id="b" load={jest.fn().mockResolvedValue(DOC_B)} />);
      await flush();

      await act(async () => {
        failSave(new Error('A could not be saved'));
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('a late clear of the first notes does not reload or empty the second', async () => {
      let finishClear;
      const clear = jest.fn().mockReturnValue(
        new Promise(resolve => {
          finishClear = resolve;
        })
      );
      const { props, rerender } = setup({ id: 'a', clear });
      await flush();
      jest.spyOn(window, 'confirm').mockReturnValueOnce(true);
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      await flush();

      const loadB = jest.fn().mockResolvedValue(DOC_B);
      rerender(<MemoryEditor {...props} id="b" load={loadB} clear={clear} />);
      await flush();
      expect(loadB).toHaveBeenCalledTimes(1);

      await act(async () => {
        finishClear({ version: 4 });
      });
      // The late clear of A does not reload B.
      expect(loadB).toHaveBeenCalledTimes(1);
      expect(textarea()).toHaveValue(DOC_B.body);
      expect(screen.getByRole('button', { name: 'Clear' })).toBeEnabled();
    });
  });

  it('does not lose unsaved text when the page re-renders with new callbacks', async () => {
    const load = jest.fn().mockResolvedValue(DOC);
    const { rerender } = setup({ load });
    await flush();
    fireEvent.change(textarea(), { target: { value: 'typing…' } });

    // A page that polls re-renders with fresh function identities every time.
    for (let i = 0; i < 3; i += 1) {
      rerender(
        <MemoryEditor
          id="task-1"
          load={jest.fn().mockResolvedValue(DOC)}
          save={jest.fn()}
          formatError={() => 'x'}
        />
      );
      await flush();
    }
    expect(textarea()).toHaveValue('typing…');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads again for a different id', async () => {
    const load = jest
      .fn()
      .mockResolvedValueOnce(DOC)
      .mockResolvedValueOnce({ body: 'other task', version: 1 });
    const { props, rerender } = setup({ load });
    await flush();
    rerender(<MemoryEditor {...props} id="task-2" />);
    await flush();
    expect(textarea()).toHaveValue('other task');
  });

  it('shows a size meter and blocks saving over the limit', async () => {
    setup({ maxChars: 10 });
    await flush();
    expect(screen.getByTestId('memory-size')).toHaveTextContent('22 / 10 characters');
    fireEvent.change(textarea(), { target: { value: 'x'.repeat(11) } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(textarea(), { target: { value: 'x'.repeat(10) } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('is read only without a save button', async () => {
    setup({ readOnly: true });
    await flush();
    expect(textarea()).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('keeps the clear button when read only, because owning the notes is enough to empty them', async () => {
    const clear = jest.fn().mockResolvedValue({ version: 4 });
    setup({ readOnly: true, clear });
    await flush();
    expect(textarea()).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    jest.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await flush();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('clears after confirmation and reloads', async () => {
    const clear = jest.fn().mockResolvedValue({ version: 4 });
    const load = jest
      .fn()
      .mockResolvedValueOnce(DOC)
      .mockResolvedValueOnce({ body: '', version: 4 });
    setup({ clear, load });
    await flush();

    jest.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await flush();
    expect(clear).not.toHaveBeenCalled();

    jest.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await flush();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(textarea()).toHaveValue('');
  });

  it('shows a load failure through formatError', async () => {
    setup({
      load: jest.fn().mockRejectedValue(new Error('not found')),
      formatError: err => `Load failed: ${err.message}`
    });
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Load failed: not found');
  });

  it('renders the notice and the slot above the text area', async () => {
    setup({ notice: 'Memory is off; these notes are kept but not used.', children: <p>slot</p> });
    await flush();
    expect(screen.getByTestId('memory-notice')).toHaveTextContent('Memory is off');
    expect(screen.getByText('slot')).toBeInTheDocument();
  });
});

describe('isVersionConflict', () => {
  it('recognizes the agent admin shape, the task API shape and a plain code', () => {
    expect(isVersionConflict({ response: { data: { error: 'VERSION_CONFLICT' } } })).toBe(true);
    expect(isVersionConflict({ code: 'VERSION_CONFLICT', status: 409 })).toBe(true);
    expect(
      isVersionConflict({ originalError: { response: { data: { code: 'VERSION_CONFLICT' } } } })
    ).toBe(true);
  });

  it('does not take other errors for conflicts', () => {
    expect(isVersionConflict(new Error('boom'))).toBe(false);
    expect(isVersionConflict({ response: { data: { error: 'MEMORY_TOO_LONG' } } })).toBe(false);
    expect(isVersionConflict(null)).toBe(false);
  });
});
