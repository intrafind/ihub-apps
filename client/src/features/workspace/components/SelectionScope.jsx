// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import useMediaQuery from '../../../shared/hooks/useMediaQuery';
import { MAX_QUOTE_CHARS } from '../utils/quote';

/**
 * The selection of the pane's own DOM inside `root`, or null.
 *
 * @param {HTMLElement|null} root
 * @returns {{ text: string, rect: DOMRect|null }|null}
 */
function selectionIn(root) {
  const selection = typeof window === 'undefined' ? null : window.getSelection?.();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode || !root.contains(anchorNode) || !root.contains(focusNode)) {
    return null;
  }
  const text = selection.toString().trim();
  if (!text) return null;
  let rect = null;
  try {
    rect = selection.getRangeAt(0).getBoundingClientRect?.() || null;
  } catch {
    rect = null;
  }
  return { text, rect };
}

/**
 * Text selected in the pane gets a small floating chip above it:
 * `[✦ Ask about] [✎ Edit with AI] [Copy]` (concept §6.1). It never takes focus
 * by itself; Ctrl/Cmd+Shift+K runs "Ask about" from the keyboard. On a touch
 * screen a sticky "Ask about selection" button replaces it. Esc dismisses it
 * (after an open menu, before anything else of the pane).
 *
 * The chip only sees what renders in the pane's own DOM. A sandboxed HTML/SVG
 * frame keeps its selection to itself; for those the caller passes `enabled`
 * false unless the Code view is shown.
 *
 * @param {Object} props
 * @param {boolean} props.enabled
 * @param {(quote: Object) => void} [props.onQuote] - Receives `{ mode, text, source }`.
 * @param {{ kind: string, id: string, name: string }} props.source - What the text is from.
 * @param {boolean} [props.allowEdit] - Offer "Edit with AI" (artifacts; never sources/uploads).
 * @param {number} [props.bottomPadding] - Space kept free for the composer dock.
 * @param {string} [props.className]
 * @param {string} [props.innerClassName]
 * @param {string} [props.testId]
 * @param {import('react').ReactNode} props.children
 */
export default function SelectionScope({
  enabled,
  onQuote,
  source,
  allowEdit = false,
  bottomPadding = 0,
  className = '',
  innerClassName = '',
  testId,
  children
}) {
  const { t } = useTranslation();
  const rootRef = useRef(null);
  const [selection, setSelection] = useState(null);
  const coarse = useMediaQuery('(pointer: coarse)');
  const active = enabled && typeof onQuote === 'function';
  const selectionRef = useRef(null);
  selectionRef.current = selection;

  useEffect(() => {
    if (!active) {
      setSelection(null);
      return undefined;
    }
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSelection(selectionIn(rootRef.current)));
    };
    document.addEventListener('selectionchange', read);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', read);
    };
  }, [active]);

  const quote = useCallback(
    mode => {
      const current = selectionRef.current || selectionIn(rootRef.current);
      if (!current) return;
      onQuote?.({ mode, text: current.text.slice(0, MAX_QUOTE_CHARS), source });
      window.getSelection?.()?.removeAllRanges?.();
      setSelection(null);
    },
    [onQuote, source]
  );

  const copy = async () => {
    const current = selectionRef.current;
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.text);
    } catch {
      // The browser's own copy still works on the selection.
    }
  };

  // Ctrl/Cmd+Shift+K asks about the selection; Esc dismisses the chip.
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = event => {
      const key = event.key?.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'k') {
        if (!selectionIn(rootRef.current)) return;
        event.preventDefault();
        quote('ask');
        return;
      }
      if (event.key === 'Escape' && selectionRef.current) {
        if (document.activeElement?.closest?.('[role="menu"]')) return;
        event.preventDefault();
        event.stopPropagation();
        window.getSelection?.()?.removeAllRanges?.();
        setSelection(null);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [active, quote]);

  // Position of the chip, relative to the scope: centred above the selection.
  let chipStyle = null;
  if (selection?.rect && rootRef.current && !coarse) {
    const box = rootRef.current.getBoundingClientRect();
    const left = selection.rect.left - box.left + selection.rect.width / 2;
    const top = selection.rect.top - box.top - 40;
    chipStyle = {
      left: Math.max(8, Math.min(left, box.width - 8)),
      top: Math.max(4, top)
    };
  }

  const chipButton =
    'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300';
  // mousedown would clear the selection before the click reads it.
  const keepSelection = event => event.preventDefault();

  return (
    <div
      ref={rootRef}
      className={`relative ${className}`}
      data-testid={testId}
      style={bottomPadding ? { paddingBottom: bottomPadding } : undefined}
    >
      {innerClassName ? <div className={innerClassName}>{children}</div> : children}
      {active && selection && !coarse && (
        <div
          role="toolbar"
          aria-label={t('workspace.selection.label', 'Selection actions')}
          data-testid="selection-chip"
          className="absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-gray-900 p-0.5 text-white shadow-lg dark:bg-gray-100 dark:text-gray-900"
          style={chipStyle || { left: '50%', top: 8 }}
          onMouseDown={keepSelection}
        >
          <button
            type="button"
            className={chipButton}
            onClick={() => quote('ask')}
            title={`${t('workspace.selection.ask', 'Ask about')} (Ctrl+Shift+K)`}
            data-testid="selection-ask"
          >
            <Icon name="sparkles" size="xs" />
            {t('workspace.selection.ask', 'Ask about')}
          </button>
          {allowEdit && (
            <button
              type="button"
              className={chipButton}
              onClick={() => quote('edit')}
              title={t(
                'workspace.selection.editHint',
                'The assistant writes a new file with the change. The original stays as it is.'
              )}
              data-testid="selection-edit"
            >
              <Icon name="pencil" size="xs" />
              {t('workspace.selection.edit', 'Edit with AI')}
            </button>
          )}
          <button type="button" className={chipButton} onClick={copy} data-testid="selection-copy">
            <Icon name="copy" size="xs" />
            {t('chatArtifacts.copy', 'Copy')}
          </button>
        </div>
      )}
      {active && selection && coarse && (
        <div className="sticky bottom-2 z-20 flex justify-center px-2 pb-2">
          <button
            type="button"
            onClick={() => quote('ask')}
            onMouseDown={keepSelection}
            className="inline-flex h-11 items-center gap-1.5 rounded-full bg-gray-900 px-4 text-sm font-medium text-white shadow-lg dark:bg-gray-100 dark:text-gray-900"
            data-testid="selection-ask-touch"
          >
            <Icon name="sparkles" size="sm" />
            {t('workspace.selection.askTouch', 'Ask about selection')}
          </button>
        </div>
      )}
    </div>
  );
}
