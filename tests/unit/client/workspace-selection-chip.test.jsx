// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The selection chip of the workspace pane (concept §6.1): text selected in the pane offers
 * "Ask about", "Edit with AI" and Copy; it never takes focus, Ctrl/Cmd+Shift+K asks from the
 * keyboard, Esc dismisses it, and it sees only selections inside its own scope. The quote it
 * hands over carries the text and what it is from.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) =>
      String(fallback).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''))
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => () => null);

const SelectionScope =
  require('../../../client/src/features/workspace/components/SelectionScope').default;
const ComposerQuote =
  require('../../../client/src/features/workspace/components/ComposerQuote').default;

const SOURCE = { kind: 'artifact', id: 'a1', name: 'Angebot.md' };

function mount(props = {}) {
  const onQuote = jest.fn();
  render(
    <>
      <SelectionScope enabled onQuote={onQuote} source={SOURCE} allowEdit {...props}>
        <p data-testid="text">Die Kündigungsfrist beträgt drei Monate.</p>
      </SelectionScope>
      <p data-testid="outside">Outside the pane</p>
      <button type="button">elsewhere</button>
    </>
  );
  return onQuote;
}

/** Selects the text of an element and lets the chip read it. */
async function select(testId) {
  const node = screen.getByTestId(testId).firstChild;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, node.textContent.length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
}

afterEach(() => window.getSelection().removeAllRanges());

describe('SelectionScope', () => {
  test('shows the chip for a selection in the pane, and never moves focus to it', async () => {
    mount();
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();
    await select('text');
    const chip = screen.getByRole('toolbar', { name: 'Selection actions' });
    expect(chip).toBeInTheDocument();
    expect(document.activeElement).toBe(elsewhere);
    expect(screen.getByRole('button', { name: 'Ask about' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit with AI' })).toHaveAttribute(
      'title',
      'The assistant writes a new file with the change. The original stays as it is.'
    );
  });

  test('"Ask about" and "Edit with AI" hand over the text and what it is from', async () => {
    const onQuote = mount();
    await select('text');
    fireEvent.click(screen.getByRole('button', { name: 'Ask about' }));
    expect(onQuote).toHaveBeenCalledWith({
      mode: 'ask',
      text: 'Die Kündigungsfrist beträgt drei Monate.',
      source: SOURCE
    });
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();

    await select('text');
    fireEvent.click(screen.getByRole('button', { name: 'Edit with AI' }));
    expect(onQuote).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'edit' }));
  });

  test('ignores a selection outside its scope', async () => {
    mount();
    await select('outside');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  test('Ctrl/Cmd+Shift+K asks about the selection; Esc dismisses the chip', async () => {
    const onQuote = mount();
    await select('text');
    // The global search listens for Ctrl/Cmd+K on window: it must not also open.
    const search = jest.fn();
    window.addEventListener('keydown', search);
    fireEvent.keyDown(document.body, { key: 'K', ctrlKey: true, shiftKey: true });
    window.removeEventListener('keydown', search);
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ask' }));
    expect(search).not.toHaveBeenCalled();

    await select('text');
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    const outer = jest.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    // The chip is the innermost layer: the pane does not also see this Escape.
    expect(outer).not.toHaveBeenCalled();
  });

  test('offers no "Edit with AI" for sources and uploads, and nothing when disabled', async () => {
    mount({ allowEdit: false });
    await select('text');
    expect(screen.queryByRole('button', { name: 'Edit with AI' })).not.toBeInTheDocument();
  });

  test('stays off when disabled (a sandboxed HTML preview)', async () => {
    mount({ enabled: false });
    await select('text');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
});

describe('ComposerQuote', () => {
  test('shows two lines and the source, says that an edit makes a new file, and can be removed', () => {
    const onRemove = jest.fn();
    render(
      <ComposerQuote
        quote={{ mode: 'edit', text: 'one\ntwo\nthree', source: SOURCE }}
        onRemove={onRemove}
      />
    );
    const block = screen.getByTestId('composer-quote');
    expect(block).toHaveTextContent('Edit in Angebot.md');
    expect(block).toHaveTextContent('one two');
    expect(block).not.toHaveTextContent('three');
    expect(block).toHaveTextContent('The assistant writes a new file with the change.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove quote' }));
    expect(onRemove).toHaveBeenCalled();
  });
});
