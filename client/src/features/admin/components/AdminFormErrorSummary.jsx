import Icon from '../../../shared/components/Icon';

/**
 * Validation error summary banner for admin forms.
 *
 * Lists all current validation errors at the top of a form with click-to-focus
 * links that scroll the corresponding field into view. Pass `errors` as either:
 *  - An object: `{ fieldId: 'error message' }`
 *  - An array of `{ field?, fieldId?, message, label? }`
 *
 * The banner auto-hides when there are no errors.
 *
 * @param {Object} props
 * @param {Object<string,string>|Array<{field?: string, fieldId?: string, message: string, label?: string}>} [props.errors]
 * @param {string} [props.title='Please fix the following errors']
 * @param {Object<string,string>} [props.labels] Optional `{ fieldId: 'Human label' }` map
 *   used when `errors` is an object; falls back to the fieldId when missing.
 */
function AdminFormErrorSummary({ errors, title = 'Please fix the following errors', labels = {} }) {
  const entries = normalizeErrors(errors);
  if (entries.length === 0) return null;

  const focusField = fieldId => {
    if (!fieldId) return;
    const el =
      document.getElementById(fieldId) ||
      document.querySelector(`[name="${fieldId}"]`) ||
      document.querySelector(`[data-field="${fieldId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (typeof el.focus === 'function') {
        // Defer focus until after scrollIntoView starts so focus ring is visible
        setTimeout(() => el.focus({ preventScroll: true }), 250);
      }
    }
  };

  return (
    <div
      className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4"
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <Icon
          name="warning"
          className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">
            {title}
            <span className="ml-1 font-normal">
              ({entries.length} {entries.length === 1 ? 'error' : 'errors'})
            </span>
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-red-700 dark:text-red-300 list-disc list-inside">
            {entries.map((e, i) => {
              const label = e.label ?? labels[e.fieldId] ?? e.fieldId;
              return (
                <li key={`${e.fieldId ?? 'err'}-${i}`}>
                  {e.fieldId ? (
                    <button
                      type="button"
                      onClick={() => focusField(e.fieldId)}
                      className="underline hover:text-red-900 dark:hover:text-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 rounded"
                    >
                      {label}
                    </button>
                  ) : (
                    <span className="font-medium">{label}</span>
                  )}
                  {label ? ': ' : ''}
                  <span>{e.message}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

function normalizeErrors(errors) {
  if (!errors) return [];
  if (Array.isArray(errors)) {
    return errors
      .filter(e => e && e.message)
      .map(e => ({ fieldId: e.fieldId ?? e.field, message: e.message, label: e.label }));
  }
  if (typeof errors === 'object') {
    return Object.entries(errors)
      .filter(([, message]) => Boolean(message))
      .map(([fieldId, message]) => ({ fieldId, message: String(message) }));
  }
  return [];
}

export default AdminFormErrorSummary;
