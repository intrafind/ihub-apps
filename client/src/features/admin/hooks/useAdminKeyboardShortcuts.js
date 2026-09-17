import { useEffect, useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const NAV_SHORTCUTS = {
  a: '/admin/apps',
  m: '/admin/models',
  p: '/admin/prompts',
  u: '/admin/users',
  g: '/admin/groups',
  s: '/admin/sources',
  l: '/admin/audit-log'
};

const SEQUENCE_TIMEOUT_MS = 300;

/**
 * Registers admin-wide keyboard shortcuts.
 *
 * Shortcuts:
 *   g + a/m/p/u/g/s/l  — navigate to section
 *   n                   — "New item" action on list pages (pass onNew)
 *   ?                   — toggle shortcut cheatsheet
 *
 * @param {Object} [options]
 * @param {() => void} [options.onNew]  Called when `n` is pressed on list pages
 * @returns {{ showCheatsheet: boolean, setShowCheatsheet: (v: boolean) => void }}
 */
export function useAdminKeyboardShortcuts({ onNew } = {}) {
  const navigate = useNavigate();
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const pendingKeyRef = useRef(null);
  const pendingTimerRef = useRef(null);

  const isInputFocused = () => {
    const tag = document.activeElement?.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      document.activeElement?.isContentEditable
    );
  };

  const handleKeyDown = useCallback(
    e => {
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();

      // ? — cheatsheet
      if (key === '?') {
        e.preventDefault();
        setShowCheatsheet(v => !v);
        return;
      }

      // n — new item
      if (key === 'n' && onNew) {
        e.preventDefault();
        onNew();
        return;
      }

      // g + letter sequence
      if (key === 'g') {
        e.preventDefault();
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
        pendingKeyRef.current = 'g';
        pendingTimerRef.current = setTimeout(() => {
          pendingKeyRef.current = null;
        }, SEQUENCE_TIMEOUT_MS);
        return;
      }

      if (pendingKeyRef.current === 'g') {
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
        pendingKeyRef.current = null;
        const target = NAV_SHORTCUTS[key];
        if (target) {
          e.preventDefault();
          navigate(target);
        }
      }
    },
    [navigate, onNew]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    };
  }, [handleKeyDown]);

  return { showCheatsheet, setShowCheatsheet };
}
