// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useMemo, useState } from 'react';
import { topLevelField } from '../utils/fieldErrors';

const FIELD_CONTROLS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * The field a form control edits: its `data-field`, `name` or `id`. Buttons
 * and other elements edit none, so moving through them marks nothing.
 *
 * @param {EventTarget|null} element
 * @returns {string|null}
 */
export function fieldOfControl(element) {
  if (!element || !FIELD_CONTROLS.has(element.tagName)) return null;
  return element.getAttribute('data-field') || element.name || element.id || null;
}

/**
 * Decides which validation errors of an admin form are shown. A blank form
 * shows none: a field's error appears once the admin has left the field or
 * changed it, and every error appears after the first attempt to save.
 *
 * The form spreads `controlHandlers` on an element around its fields. A blur
 * or a change of an input, textarea or select inside marks the field it edits
 * (`data-field`, `name` or `id`, up to the first dot) as touched.
 *
 * @param {Object<string, string>} errors - All messages by field path.
 * @param {object} [options]
 * @param {boolean} [options.showAll=false] - True after a save attempt.
 * @returns {{
 *   visibleErrors: Object<string, string>,
 *   touch: (field: string) => void,
 *   controlHandlers: { onBlurCapture: function, onChangeCapture: function }
 * }}
 *
 * @example
 * const { visibleErrors, controlHandlers } = useFieldErrorVisibility(errors, { showAll });
 * return <div {...controlHandlers}>…</div>;
 */
export default function useFieldErrorVisibility(errors, { showAll = false } = {}) {
  const [touched, setTouched] = useState(() => new Set());

  const touch = useCallback(field => {
    const top = topLevelField(field);
    if (!top) return;
    setTouched(previous => (previous.has(top) ? previous : new Set(previous).add(top)));
  }, []);

  const handleControlEvent = useCallback(
    event => {
      const field = fieldOfControl(event.target);
      if (field) touch(field);
    },
    [touch]
  );

  const visibleErrors = useMemo(() => {
    if (showAll) return errors;
    return Object.fromEntries(
      Object.entries(errors).filter(([field]) => touched.has(topLevelField(field)))
    );
  }, [errors, showAll, touched]);

  const controlHandlers = useMemo(
    () => ({ onBlurCapture: handleControlEvent, onChangeCapture: handleControlEvent }),
    [handleControlEvent]
  );

  return { visibleErrors, touch, controlHandlers };
}
