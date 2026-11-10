// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The rules of the workspace pane that need no React: width limits, divider keys, what the
 * URL says is open, when the pane splits, which layer Esc closes, when the sidebar folds, and
 * the message a quoted passage becomes.
 */
import {
  PANE_LIMITS,
  WIDTH_STORAGE_KEY,
  clampPaneWidth,
  defaultPaneWidth,
  escapeLayer,
  paneWidthBounds,
  presentationOf,
  readPaneParams,
  readStoredWidth,
  sameTarget,
  shouldAutoCollapseSidebar,
  widthAfterKey,
  widthPercent,
  writePaneParams,
  writeStoredWidth
} from '../../../client/src/features/workspace/utils/workspaceState';
import {
  composeQuotedMessage,
  quoteExcerpt
} from '../../../client/src/features/workspace/utils/quote';

const t = (key, fallback, options = {}) =>
  String(fallback).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));

describe('pane width', () => {
  test('opens at half the row, clamped to 420–960px', () => {
    expect(defaultPaneWidth(1600)).toBe(800);
    expect(defaultPaneWidth(2400)).toBe(960);
    expect(defaultPaneWidth(900)).toBe(450);
    // 50% of 800 is 400, below the 420 default floor…
    expect(defaultPaneWidth(800)).toBe(420);
  });

  test('never leaves the chat less than 360px, nor takes more than 70%', () => {
    expect(paneWidthBounds(2000)).toEqual({ min: 360, max: 1400 });
    // 70% of 1000 would leave the chat 300px: the chat minimum wins.
    expect(paneWidthBounds(1000)).toEqual({ min: 360, max: 640 });
    // …and in a narrow row the default yields to the limits too.
    expect(defaultPaneWidth(760)).toBe(400);
    expect(clampPaneWidth(5000, 1400)).toBe(980);
    expect(clampPaneWidth(100, 1400)).toBe(PANE_LIMITS.min);
    expect(clampPaneWidth(Number.NaN, 1600)).toBe(800);
  });

  test('arrow keys resize, Shift by more, Home/End snap to the limits', () => {
    expect(widthAfterKey('ArrowLeft', 600, 1600)).toBe(616);
    expect(widthAfterKey('ArrowRight', 600, 1600)).toBe(584);
    expect(widthAfterKey('ArrowLeft', 600, 1600, { shiftKey: true })).toBe(664);
    expect(widthAfterKey('Home', 600, 1600)).toBe(360);
    expect(widthAfterKey('End', 600, 1600)).toBe(1120);
    expect(widthAfterKey('ArrowLeft', 1120, 1600)).toBe(1120);
    expect(widthAfterKey('Enter', 600, 1600)).toBeNull();
  });

  test('is said as a percentage of the row', () => {
    expect(widthPercent(880, 1600)).toBe(55);
    expect(widthPercent(500, 0)).toBe(0);
  });

  test('is remembered in localStorage, and storage failures are harmless', () => {
    const store = new Map();
    const storage = {
      getItem: key => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: key => store.delete(key)
    };
    writeStoredWidth(612.4, storage);
    expect(store.get(WIDTH_STORAGE_KEY)).toBe('612');
    expect(readStoredWidth(storage)).toBe(612);
    writeStoredWidth(null, storage);
    expect(readStoredWidth(storage)).toBeNull();

    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      }
    };
    expect(readStoredWidth(broken)).toBeNull();
    expect(() => writeStoredWidth(500, broken)).not.toThrow();
    expect(readStoredWidth(null)).toBeNull();
  });
});

describe('URL state', () => {
  test('reads the item and full screen from the search parameters', () => {
    expect(readPaneParams(new URLSearchParams('artifact=a1&view=full'))).toEqual({
      target: { kind: 'artifact', id: 'a1' },
      full: true
    });
    expect(readPaneParams(new URLSearchParams('source=s1'))).toEqual({
      target: { kind: 'source', id: 's1' },
      full: false
    });
    expect(readPaneParams(new URLSearchParams('file=f1')).target).toEqual({
      kind: 'file',
      id: 'f1'
    });
    expect(readPaneParams(new URLSearchParams('files=uploaded')).target).toEqual({
      kind: 'files',
      tab: 'uploaded'
    });
    expect(readPaneParams(new URLSearchParams('files=bogus')).target).toEqual({
      kind: 'files',
      tab: null
    });
    // Full screen without an item is nothing.
    expect(readPaneParams(new URLSearchParams('view=full'))).toEqual({ target: null, full: false });
    expect(readPaneParams(new URLSearchParams('x=1'))).toEqual({ target: null, full: false });
  });

  test('writes one item at a time and keeps every other parameter', () => {
    const base = new URLSearchParams('x=1&artifact=old&view=full');
    expect(writePaneParams(base, { kind: 'source', id: 's 1' }).toString()).toBe('x=1&source=s+1');
    expect(writePaneParams(base, { kind: 'artifact', id: 'a2' }, true).toString()).toBe(
      'x=1&artifact=a2&view=full'
    );
    expect(writePaneParams(base, { kind: 'files', tab: 'sources' }).toString()).toBe(
      'x=1&files=sources'
    );
    expect(writePaneParams(base, null).toString()).toBe('x=1');
    // The original is left alone.
    expect(base.get('artifact')).toBe('old');
  });

  test('round-trips', () => {
    const target = { kind: 'file', id: 'file_9' };
    expect(readPaneParams(writePaneParams(new URLSearchParams(), target, true))).toEqual({
      target,
      full: true
    });
  });

  test('compares targets', () => {
    expect(sameTarget({ kind: 'artifact', id: 'a' }, { kind: 'artifact', id: 'a' })).toBe(true);
    expect(sameTarget({ kind: 'artifact', id: 'a' }, { kind: 'file', id: 'a' })).toBe(false);
    expect(sameTarget({ kind: 'files', tab: 'uploaded' }, { kind: 'files', tab: 'uploaded' })).toBe(
      true
    );
    expect(sameTarget({ kind: 'files', tab: 'uploaded' }, { kind: 'files', tab: null })).toBe(
      false
    );
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(null, { kind: 'files' })).toBe(false);
  });
});

describe('presentation', () => {
  test('splits from 1024px, otherwise a sheet', () => {
    expect(presentationOf({ viewportWidth: 1440 })).toBe('split');
    expect(presentationOf({ viewportWidth: 1024 })).toBe('split');
    expect(presentationOf({ viewportWidth: 1023 })).toBe('sheet');
  });

  test('never splits on an embedded surface or when the caller says so', () => {
    expect(presentationOf({ viewportWidth: 1440, surface: 'office' })).toBe('sheet');
    expect(presentationOf({ viewportWidth: 1440, surface: 'extension' })).toBe('sheet');
    expect(presentationOf({ viewportWidth: 1440, forceSheet: true })).toBe('sheet');
  });
});

describe('Esc', () => {
  test('closes the innermost layer first', () => {
    const inPane = { inPane: true };
    expect(escapeLayer({ ...inPane, menuOpen: true, chipOpen: true, full: true })).toBe('menu');
    expect(escapeLayer({ ...inPane, chipOpen: true, dockExpanded: true })).toBe('chip');
    expect(escapeLayer({ ...inPane, dockExpanded: true, full: true })).toBe('dock');
    expect(escapeLayer({ ...inPane, full: true })).toBe('full');
    expect(escapeLayer(inPane)).toBe('pane');
  });

  test('does nothing from the composer or outside the pane', () => {
    expect(escapeLayer({ inPane: true, inComposer: true, full: true })).toBeNull();
    expect(escapeLayer({ inPane: false, full: true })).toBeNull();
  });
});

describe('sidebar auto-collapse', () => {
  const base = {
    viewportWidth: 1100,
    collapsed: false,
    alreadyThisSession: false,
    userExpanded: false
  };
  test('folds below 1280px, once per tab session, and a manual expand wins', () => {
    expect(shouldAutoCollapseSidebar(base)).toBe(true);
    expect(shouldAutoCollapseSidebar({ ...base, viewportWidth: 1280 })).toBe(false);
    expect(shouldAutoCollapseSidebar({ ...base, collapsed: true })).toBe(false);
    expect(shouldAutoCollapseSidebar({ ...base, alreadyThisSession: true })).toBe(false);
    expect(shouldAutoCollapseSidebar({ ...base, userExpanded: true })).toBe(false);
  });
});

describe('quoted passages', () => {
  const quote = {
    mode: 'ask',
    text: 'Die Kündigungsfrist\nbeträgt drei Monate.\nDritte Zeile.',
    source: { kind: 'artifact', id: 'a1', name: 'Angebot.md' }
  };

  test('show two lines above the composer', () => {
    expect(quoteExcerpt(quote.text)).toBe('Die Kündigungsfrist\nbeträgt drei Monate.');
  });

  test('become a block quote with what it is from, before the question', () => {
    expect(composeQuotedMessage(quote, 'What does this mean?', t)).toBe(
      'About this passage of "Angebot.md" (artifact id: a1):\n\n' +
        '> Die Kündigungsfrist\n> beträgt drei Monate.\n> Dritte Zeile.\n\nWhat does this mean?'
    );
  });

  test('"Edit with AI" asks for a new file', () => {
    const message = composeQuotedMessage({ ...quote, mode: 'edit' }, 'Make it six months.', t);
    expect(message).toMatch(
      /^Edit this passage of "Angebot.md" \(artifact id: a1\) and give me the whole document again as a new file:/
    );
    expect(message).toMatch(/Make it six months\.$/);
  });

  test('a live file or an upload carries no artifact id; no quote leaves the text alone', () => {
    expect(
      composeQuotedMessage(
        { ...quote, source: { kind: 'artifact', id: 'live:1', name: 'x' } },
        'q',
        t
      )
    ).not.toMatch(/artifact id/);
    expect(
      composeQuotedMessage({ ...quote, source: { kind: 'file', id: 'f1', name: 'x.pdf' } }, 'q', t)
    ).not.toMatch(/artifact id/);
    expect(composeQuotedMessage(null, 'plain', t)).toBe('plain');
  });
});
