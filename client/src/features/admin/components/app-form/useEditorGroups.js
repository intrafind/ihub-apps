// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which groups of the app editor are open, and where its validation errors
 * are. The editor page calls the hook once and hands the result to the form,
 * to the index and to the group it renders itself, so all of them share one
 * state.
 *
 * A group opens itself in three cases only: a validation error appears in it,
 * the author follows a link to it (`open`, or the URL hash `#<group id>`), or
 * the author expands all. It never opens because its values differ from the
 * defaults; `changed` only marks it.
 *
 * @module features/admin/components/app-form/useEditorGroups
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EDITOR_GROUPS,
  groupChanged,
  groupDomIds,
  groupOfField,
  groupSummary,
  isEditorGroupId
} from './editorGroups';

const NO_ERRORS = Object.freeze([]);
const FOCUSABLE = 'input, textarea, select, button, [tabindex]';

/** The group the URL hash names, or null. */
function groupFromHash() {
  if (typeof window === 'undefined') return null;
  const id = window.location.hash.slice(1);
  return isEditorGroupId(id) ? id : null;
}

function initialOpenState() {
  const linked = groupFromHash();
  return Object.fromEntries(
    EDITOR_GROUPS.map(group => [group.id, group.defaultOpen || group.id === linked])
  );
}

const allGroups = open => Object.fromEntries(EDITOR_GROUPS.map(group => [group.id, open]));

/**
 * The control of a field, found like the error summary finds it: by `id`,
 * `name` or `data-field`, for the path and then for each parent path
 * (`description.en`, then `description`).
 */
function findFieldControl(path) {
  const parts = String(path).split('.');
  for (; parts.length > 0; parts.pop()) {
    const candidate = parts.join('.');
    const quoted = candidate.replaceAll(/["\\]/g, String.raw`\$&`);
    const element =
      document.getElementById(candidate) ||
      document.querySelector(`[name="${quoted}"], [data-field="${quoted}"]`);
    if (element) return element.matches(FOCUSABLE) ? element : element.querySelector(FOCUSABLE);
  }
  return null;
}

/**
 * Moves the focus to a field of a group, or to the group's header when no
 * field is asked for or found. Returns false while the group is not rendered.
 */
function moveFocus({ id, field }) {
  const control = field ? findFieldControl(field) : null;
  if (control) {
    control.scrollIntoView?.({ block: 'center' });
    control.focus({ preventScroll: true });
    return true;
  }
  const ids = groupDomIds(id);
  const header = document.getElementById(ids.header);
  if (!header) return false;
  (document.getElementById(ids.group) || header).scrollIntoView?.({ block: 'start' });
  header.focus({ preventScroll: true });
  return true;
}

/** Errors per group, their number, and the first field in page order. */
function locateErrors(errors) {
  const counts = new Map();
  let total = 0;
  let firstField = null;
  let firstRank = Infinity;
  for (const error of errors) {
    if (!error) continue;
    total += 1;
    const id = groupOfField(error.field);
    counts.set(id, (counts.get(id) || 0) + 1);
    const rank = EDITOR_GROUPS.findIndex(group => group.id === id);
    if (error.field && rank < firstRank) {
      firstField = error.field;
      firstRank = rank;
    }
  }
  return { counts, total, firstField };
}

/**
 * The shared state of the editor's groups.
 *
 * @param {object} options
 * @param {object|null} options.app - The app as the editor holds it.
 * @param {Array<{field: string, message: string}>} [options.errors] - What the
 *   form reports through `onValidationChange`.
 * @param {object} [options.extra] - What `groupSummary` needs beyond the app
 *   (`models`, `language`, `access`); see there.
 * @returns {{
 *   isOpen: function(string): boolean,
 *   toggle: function(string): void,
 *   open: function(string, {focus?: boolean|string}=): void,
 *   expandAll: function(): void,
 *   collapseAll: function(): void,
 *   errorCount: function(string): number,
 *   totalErrors: number,
 *   firstErrorField: string|null,
 *   groups: Array<object>,
 *   allOpen: boolean,
 *   summary: function(string, function): string,
 *   changed: function(string): boolean,
 *   app: object|null,
 *   extra: object|undefined
 * }} `open(id, { focus: true })` moves the focus to the group's header,
 *   `open(id, { focus: 'variables.0.name' })` to that field. `groups` are the
 *   entries of `EDITOR_GROUPS` that apply to the app's type; `allOpen` says
 *   whether all of them are open. `summary(id, t)` and `changed(id)` are
 *   `groupSummary` and `groupChanged` for this app.
 *
 * @example
 * const groups = useEditorGroups({ app, errors: validationState.errors });
 * groups.open(groupOfField(groups.firstErrorField), { focus: groups.firstErrorField });
 */
export function useEditorGroups({ app = null, errors, extra } = {}) {
  const [openIds, setOpenIds] = useState(initialOpenState);
  // A URL that names a group also moves the focus there, once the group is rendered.
  const [focusRequest, setFocusRequest] = useState(() => {
    const id = groupFromHash();
    return id ? { id, field: null } : null;
  });
  const handledRequestRef = useRef(null);

  const errorList = Array.isArray(errors) ? errors : NO_ERRORS;
  const located = useMemo(() => locateErrors(errorList), [errorList]);

  // A group opens when an error appears in it, not on every validation run:
  // the author can collapse it again, and its header keeps the count.
  const erroredIds = EDITOR_GROUPS.filter(group => located.counts.has(group.id))
    .map(group => group.id)
    .join(',');
  const [seenErroredIds, setSeenErroredIds] = useState('');
  if (erroredIds !== seenErroredIds) {
    const seen = seenErroredIds.split(',');
    const fresh = erroredIds.split(',').filter(id => id && !seen.includes(id));
    setSeenErroredIds(erroredIds);
    if (fresh.length > 0) {
      setOpenIds(current => ({ ...current, ...Object.fromEntries(fresh.map(id => [id, true])) }));
    }
  }

  const toggle = useCallback(id => {
    if (isEditorGroupId(id)) setOpenIds(current => ({ ...current, [id]: !current[id] }));
  }, []);

  const open = useCallback((id, { focus } = {}) => {
    if (!isEditorGroupId(id)) return;
    setOpenIds(current => (current[id] ? current : { ...current, [id]: true }));
    if (focus) setFocusRequest({ id, field: typeof focus === 'string' ? focus : null });
  }, []);

  const expandAll = useCallback(() => setOpenIds(allGroups(true)), []);
  const collapseAll = useCallback(() => setOpenIds(allGroups(false)), []);

  // After the commit, so that the group is no longer hidden when it gets the
  // focus. A request made before the app is loaded waits for it.
  const loaded = Boolean(app);
  useEffect(() => {
    if (!focusRequest || handledRequestRef.current === focusRequest) return;
    if (moveFocus(focusRequest)) handledRequestRef.current = focusRequest;
  }, [focusRequest, loaded]);

  // A hash the author types or a plain link sets. A router link that only
  // changes the hash fires no event; in-app links call `open` instead.
  useEffect(() => {
    const onHashChange = () => {
      const id = groupFromHash();
      if (id) open(id, { focus: true });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [open]);

  return useMemo(() => {
    const type = app?.type || 'chat';
    const groups = EDITOR_GROUPS.filter(group => group.types.includes(type));
    return {
      isOpen: id => openIds[id] === true,
      toggle,
      open,
      expandAll,
      collapseAll,
      errorCount: id => located.counts.get(id) || 0,
      totalErrors: located.total,
      firstErrorField: located.firstField,
      groups,
      allOpen: groups.every(group => openIds[group.id] === true),
      summary: (id, t) => groupSummary(id, app, t, extra),
      changed: id => groupChanged(id, app),
      app,
      extra
    };
  }, [app, extra, openIds, located, toggle, open, expandAll, collapseAll]);
}

export default useEditorGroups;
