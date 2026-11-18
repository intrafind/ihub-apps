// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useEffect, useRef } from 'react';
import { deepEqual } from './useUnsavedChanges';

/**
 * Lets a page collect "has unsaved edits" from editors it renders but does not
 * own the state of (for example the dedicated installation editors on an
 * integration's Settings tab). The value is the `onDirtyChange` callback the
 * editors pass to `useDirtyReport`; without a provider it is undefined and the
 * report goes nowhere.
 *
 * @type {React.Context<((dirty: boolean) => void) | undefined>}
 */
export const DirtyReportContext = createContext(undefined);

/**
 * Works out whether a self-contained settings section (one that loads and saves
 * on its own, such as a card on the Security page) has unsaved edits, and tells
 * its page through `onDirtyChange`. The page passes that flag on as
 * `sections[].dirty` to `AdminSettingsPage`, which marks the section in its nav
 * and guards the whole page with one "Leave without saving?" prompt.
 *
 * @param {*} savedValue - The value as last loaded or saved; null while loading
 *   or after the load failed (never dirty then).
 * @param {*} currentValue - The value being edited.
 * @param {(dirty: boolean) => void} [onDirtyChange] - Called whenever the flag changes.
 * @returns {boolean} Whether the section is dirty.
 *
 * @example
 * function CorsConfig({ onDirtyChange }) {
 *   const [saved, setSaved] = useState(null);
 *   const [config, setConfig] = useState(DEFAULTS);
 *   useDirtyReport(saved, config, onDirtyChange);
 * }
 */
export function useDirtyReport(savedValue, currentValue, onDirtyChange) {
  const isDirty = savedValue !== null && !deepEqual(savedValue, currentValue);
  const callbackRef = useRef(onDirtyChange);
  callbackRef.current = onDirtyChange;

  useEffect(() => {
    callbackRef.current?.(isDirty);
  }, [isDirty]);

  // A section that goes away no longer holds unsaved edits.
  useEffect(() => () => callbackRef.current?.(false), []);

  return isDirty;
}
