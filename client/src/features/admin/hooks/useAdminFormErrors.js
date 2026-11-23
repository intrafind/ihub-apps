// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo } from 'react';
import useFieldErrorVisibility from './useFieldErrorVisibility';

const NO_ERRORS = Object.freeze({});

/**
 * The validation state an admin form reports to the editor around it
 * (`DualModeEditor`) and to its page.
 *
 * @typedef {Object} FormValidationReport
 * @property {boolean} isValid - No problem at all, shown or not.
 * @property {Array<{field: string, message: string, severity: 'error'}>} errors - Every problem.
 * @property {boolean} displayed - The form shows errors itself; the editor around it only
 *   marks them and leaves out its own summary.
 */

/**
 * Builds the report of a form from all its problems and whether any is shown.
 *
 * @param {Object<string, string>} allErrors - Every message by field path.
 * @param {boolean} displayed - Whether the form shows any error.
 * @returns {FormValidationReport}
 */
export function validationReport(allErrors, displayed) {
  return {
    isValid: Object.keys(allErrors).length === 0,
    errors: Object.entries(allErrors).map(([field, message]) => ({
      field,
      message,
      severity: 'error'
    })),
    displayed
  };
}

/**
 * The validation glue of the model, prompt, group and user forms: which
 * problems are shown (`useFieldErrorVisibility`), merged with messages the page
 * passes in (a server answer), and the report to `onValidationChange` each
 * time the problems or their visibility change. The form keeps only its own
 * rules (`<x>FieldErrors()`).
 *
 * @param {Object<string, string>} allErrors - Every message by field path; memoize it.
 * @param {Object} [options]
 * @param {boolean} [options.showAll=false] - True after a save attempt.
 * @param {Object<string, string>} [options.extraErrors] - Messages from outside the form,
 *   always shown.
 * @param {(report: FormValidationReport) => void} [options.onValidationChange]
 * @returns {{ errors: Object<string, string>, controlHandlers: Object }} The messages the
 *   fields show, and the handlers to spread on the element around the fields.
 *
 * @example
 * const allErrors = useMemo(() => groupFieldErrors(group, schema, t, opts), [group, schema, t]);
 * const { errors, controlHandlers } = useAdminFormErrors(allErrors, {
 *   showAll: showAllErrors,
 *   onValidationChange
 * });
 */
export default function useAdminFormErrors(
  allErrors,
  { showAll = false, extraErrors = NO_ERRORS, onValidationChange } = {}
) {
  const { visibleErrors, controlHandlers } = useFieldErrorVisibility(allErrors, { showAll });
  const errors = useMemo(
    () => (Object.keys(extraErrors).length ? { ...visibleErrors, ...extraErrors } : visibleErrors),
    [visibleErrors, extraErrors]
  );
  const displayed = Object.keys(errors).length > 0;
  // Reported when the problems change, not on every render.
  const errorsKey = JSON.stringify(allErrors);

  useEffect(() => {
    onValidationChange?.(validationReport(allErrors, displayed));
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [errorsKey, displayed]);

  return { errors, controlHandlers };
}
