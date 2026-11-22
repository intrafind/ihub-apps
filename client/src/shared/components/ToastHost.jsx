// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import { useAnnounce } from '../announce/AnnouncerProvider';

/** Most toasts on screen at once; more wait until one closes. */
export const MAX_VISIBLE_TOASTS = 3;

/** How long a toast that does not need the person stays. */
export const TOAST_MS = 12_000;

const ToastContext = createContext(null);

const NO_TOASTS = Object.freeze({ show: () => {}, dismiss: () => {} });

/**
 * @typedef {Object} Toast
 * @property {string} id - Unique; a toast shown again with the same id replaces the first.
 * @property {string} text - What the toast says; also said to a screen reader.
 * @property {'info'|'danger'} [tone='info']
 * @property {string} [icon] - An `Icon` name, decoration only.
 * @property {Array<{label: string, to: string}>} [links] - In-app links; following one closes the toast.
 * @property {boolean} [needsYou=false] - The toast is about something that waits for the
 *   person: it stays until they close it.
 */

/**
 * ToastHost — the page's toasts, bottom right: at most
 * {@link MAX_VISIBLE_TOASTS} at once, the others wait for their turn (see
 * {@link visibleToasts}). A toast closes by itself after {@link TOAST_MS}
 * unless it is about something that needs the person (`needsYou`); every toast
 * has a close button with a 24 px target. The host has no live region of its
 * own: what a toast says is said through the page's announcer when the toast
 * becomes visible.
 *
 * Rendered by {@link ToastProvider}; use {@link useToasts} to show one.
 *
 * @param {Object} props
 * @param {Toast[]} props.toasts - Visible toasts, oldest first.
 * @param {(id: string) => void} props.onDismiss
 * @returns {JSX.Element|null}
 */
export function ToastHost({ toasts, onDismiss }) {
  const { t } = useTranslation();
  if (toasts.length === 0) return null;
  return (
    <section
      aria-label={t('toast.region', 'Notifications')}
      className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] space-y-2"
      data-testid="toast-host"
    >
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </section>
  );
}

/**
 * One toast. Its clock starts when it becomes visible, not when it is queued;
 * a toast that needs the person has no clock.
 */
function ToastItem({ toast, onDismiss }) {
  const { t } = useTranslation();
  const { id, text, needsYou } = toast;

  useEffect(() => {
    if (needsYou) return undefined;
    const timer = setTimeout(() => onDismiss(id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [id, needsYou, onDismiss]);

  return (
    <div
      data-testid="toast"
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg p-3 text-sm flex gap-3"
    >
      {toast.icon && (
        <span aria-hidden="true" className="shrink-0">
          <Icon
            name={toast.icon}
            size="md"
            className={
              toast.tone === 'danger'
                ? 'text-red-600 dark:text-red-400'
                : 'text-indigo-600 dark:text-indigo-400'
            }
          />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <p className="break-words text-gray-900 dark:text-gray-100">{text}</p>
        {toast.links?.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {toast.links.map(link => (
              <Link
                key={`${link.to}|${link.label}`}
                to={link.to}
                onClick={() => onDismiss(id)}
                className="text-indigo-700 dark:text-indigo-300 underline-offset-2 hover:underline"
              >
                {link.label}
              </Link>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(id)}
        aria-label={t('toast.close', 'Close notification: {{text}}', { text })}
        className="inline-flex shrink-0 items-center justify-center min-h-6 min-w-6 rounded-md text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
  );
}

/**
 * Holds the page's toasts and renders the {@link ToastHost}. A provider inside
 * another one adds no second host.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children
 * @returns {JSX.Element}
 */
export function ToastProvider({ children }) {
  const outer = use(ToastContext);
  if (outer) return children;
  return <ToastRoot>{children}</ToastRoot>;
}

/**
 * The toasts that are visible now, oldest first: at most `max`, and at most
 * `max - 1` of them toasts that need the person (`needsYou`). Those never close
 * by themselves, so without the free slot three of them would hold the screen
 * and a later toast (a failure) would wait unseen and unsaid until one is
 * closed. Taken oldest first, so a toast that is visible stays visible when a
 * newer one arrives.
 *
 * @param {Toast[]} toasts - All toasts, oldest first.
 * @param {number} [max=MAX_VISIBLE_TOASTS]
 * @returns {Toast[]}
 */
export function visibleToasts(toasts, max = MAX_VISIBLE_TOASTS) {
  const stickyMax = Math.max(1, max - 1);
  const shown = [];
  let sticky = 0;
  for (const toast of toasts) {
    if (shown.length >= max) break;
    if (toast.needsYou) {
      if (sticky >= stickyMax) continue;
      sticky += 1;
    }
    shown.push(toast);
  }
  return shown;
}

function ToastRoot({ children }) {
  const [toasts, setToasts] = useState([]);
  const announce = useAnnounce();
  // The ids said so far: a toast is said once when it becomes visible, not again
  // when it waits for a while and comes back. A closed toast shown again is new.
  const saidRef = useRef(new Set());

  const dismiss = useCallback(id => {
    saidRef.current.delete(id);
    setToasts(current => current.filter(toast => toast.id !== id));
  }, []);

  const show = useCallback(toast => {
    if (!toast?.id || !toast.text) return;
    setToasts(current => {
      const at = current.findIndex(entry => entry.id === toast.id);
      if (at === -1) return [...current, toast];
      const next = [...current];
      next[at] = toast;
      return next;
    });
  }, []);

  const visible = useMemo(() => visibleToasts(toasts), [toasts]);

  useEffect(() => {
    for (const toast of visible) {
      if (saidRef.current.has(toast.id)) continue;
      saidRef.current.add(toast.id);
      announce(toast.text);
    }
  }, [visible, announce]);

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext value={value}>
      {children}
      <ToastHost toasts={visible} onDismiss={dismiss} />
    </ToastContext>
  );
}

/**
 * Show and close toasts: `const { show, dismiss } = useToasts()`. Outside a
 * {@link ToastProvider} both do nothing.
 *
 * @returns {{show: (toast: Toast) => void, dismiss: (id: string) => void}}
 */
export function useToasts() {
  return use(ToastContext) || NO_TOASTS;
}

export default ToastHost;
