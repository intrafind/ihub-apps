/**
 * Standard admin text input.
 *
 * @param {Object} props
 * @param {string} [props.error] Error message — switches border to red and shows message below
 * @param {string} [props.helperText] Muted helper text below input (not shown when error is set)
 * @param {string} [props.label] Label text above input
 * @param {string} [props.id] Input id (required when label is set)
 * @param {boolean} [props.disabled]
 */
function AdminInput({ error, helperText, label, id, disabled, className = '', ...rest }) {
  const baseClasses =
    'block w-full rounded-lg border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-0';

  const stateClasses = error
    ? 'border-red-300 dark:border-red-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-red-500 focus:border-red-500'
    : disabled
      ? 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400 cursor-not-allowed'
      : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-indigo-500 focus:border-indigo-500';

  return (
    <div>
      {label && (
        <label
          htmlFor={id}
          className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
        >
          {label}
        </label>
      )}
      <input
        id={id}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : helperText ? `${id}-helper` : undefined}
        className={`${baseClasses} ${stateClasses} ${className}`}
        {...rest}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {!error && helperText && (
        <p id={`${id}-helper`} className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {helperText}
        </p>
      )}
    </div>
  );
}

export default AdminInput;
