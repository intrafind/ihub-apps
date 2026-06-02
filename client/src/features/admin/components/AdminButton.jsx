const VARIANT_CLASSES = {
  primary:
    'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm border border-transparent focus:ring-indigo-500',
  secondary:
    'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 focus:ring-indigo-500',
  danger:
    'bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-700 focus:ring-red-500',
  ghost:
    'bg-transparent hover:bg-gray-100 dark:hover:bg-gray-700/50 text-gray-600 dark:text-gray-300 border border-transparent focus:ring-indigo-500'
};

const SIZE_CLASSES = {
  sm: 'px-3 py-1.5 text-xs gap-1.5',
  md: 'px-4 py-2 text-sm gap-2'
};

/**
 * Standard admin button replacing ad-hoc Tailwind class strings.
 *
 * @param {Object} props
 * @param {'primary'|'secondary'|'danger'|'ghost'} [props.variant='secondary']
 * @param {'sm'|'md'} [props.size='md']
 * @param {boolean} [props.loading] Shows inline spinner, disables button
 * @param {boolean} [props.disabled]
 * @param {string} [props.type='button']
 * @param {React.ReactNode} [props.icon] Icon element rendered before label
 * @param {React.ReactNode} props.children
 */
function AdminButton({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled = false,
  type = 'button',
  icon,
  children,
  className = '',
  ...rest
}) {
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      disabled={isDisabled}
      className={[
        'inline-flex items-center justify-center rounded-lg font-medium',
        'transition-all duration-150',
        'focus:outline-none focus:ring-2 focus:ring-offset-2',
        'active:scale-95',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
        VARIANT_CLASSES[variant] ?? VARIANT_CLASSES.secondary,
        SIZE_CLASSES[size] ?? SIZE_CLASSES.md,
        className
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {loading ? (
        <svg
          className="w-4 h-4 animate-spin shrink-0"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      ) : (
        icon && <span className="shrink-0">{icon}</span>
      )}
      {children}
    </button>
  );
}

export default AdminButton;
