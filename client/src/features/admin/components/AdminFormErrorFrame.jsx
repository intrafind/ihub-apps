// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import AdminFormErrorSummary from './AdminFormErrorSummary';
import { FormValidationProvider } from '../../../shared/contexts/formValidationContext';

/**
 * The frame of an admin form that shows its own errors: provides the shown
 * messages to the localized fields inside (`FormValidationProvider`), marks the
 * fields the admin touches (`controlHandlers` of `useAdminFormErrors`) and,
 * after a save attempt, puts the one error summary on top.
 *
 * Used by the model, prompt, group and user editors.
 *
 * @param {Object} props
 * @param {Object<string, string>} props.errors - The messages the fields show.
 * @param {Object<string, string>|Array<Object>} [props.summaryErrors] - What the summary
 *   lists, when it names fields differently from `errors`; by default `errors`.
 * @param {Object} props.controlHandlers - From `useAdminFormErrors`.
 * @param {boolean} props.showSummary - True after a save attempt.
 * @param {Object<string, string>} [props.labels] - Field labels for the summary.
 * @param {string} [props.title] - The summary heading.
 * @param {number} [props.focusKey] - A new value moves the focus to the summary.
 * @param {string} [props.className] - Classes of the element around the fields.
 * @param {React.ReactNode} props.children - The fields.
 * @returns {JSX.Element}
 */
function AdminFormErrorFrame({
  errors,
  summaryErrors,
  controlHandlers,
  showSummary,
  labels,
  title,
  focusKey,
  className,
  children
}) {
  return (
    <FormValidationProvider errors={errors}>
      <div className={className} {...controlHandlers}>
        {/* One summary, after a save attempt; before it only touched fields say what is wrong. */}
        {showSummary && (
          <AdminFormErrorSummary
            errors={summaryErrors ?? errors}
            labels={labels}
            title={title}
            focusKey={focusKey}
          />
        )}
        {children}
      </div>
    </FormValidationProvider>
  );
}

export default AdminFormErrorFrame;
