// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Colour pairs per tone, light and dark, taken from the pills the admin
 * already uses (`bg-{colour}-100 text-{colour}-800`, dark
 * `bg-{colour}-900/50 text-{colour}-300`). Every pair keeps text contrast at
 * or above 4.5:1 in both themes.
 */
const TONES = {
  neutral: {
    soft: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
    outline: 'border-gray-300 text-gray-700 dark:border-gray-600 dark:text-gray-300'
  },
  info: {
    soft: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300',
    outline: 'border-blue-300 text-blue-800 dark:border-blue-700 dark:text-blue-300'
  },
  success: {
    soft: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
    outline: 'border-green-300 text-green-800 dark:border-green-700 dark:text-green-300'
  },
  warning: {
    soft: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
    outline: 'border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300'
  },
  danger: {
    soft: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
    outline: 'border-red-300 text-red-800 dark:border-red-700 dark:text-red-300'
  },
  accent: {
    soft: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300',
    outline: 'border-indigo-300 text-indigo-800 dark:border-indigo-700 dark:text-indigo-300'
  },
  highlight: {
    soft: 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300',
    outline: 'border-purple-300 text-purple-800 dark:border-purple-700 dark:text-purple-300'
  }
};

const VARIANT_BASE = {
  soft: '',
  outline: 'border bg-transparent dark:bg-transparent'
};

const SIZES = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-0.5 text-sm'
};

const SHAPES = {
  pill: 'rounded-full',
  rounded: 'rounded-sm'
};

/** The tones a Badge accepts, for callers that map their own states onto them. */
export const BADGE_TONES = Object.keys(TONES);

/**
 * Badge — a short, non-interactive label: a state ("Installed"), a kind
 * ("Preview"), an effect ("Read and write") or a trust level ("Verified").
 *
 * The text carries the meaning; the colour only repeats it. Do not use a
 * badge without text, and do not make a badge clickable (wrap it in a button
 * or link when it has to be).
 *
 * Tones: `neutral` (gray), `info` (blue), `success` (green), `warning`
 * (amber), `danger` (red), `accent` (indigo, the product accent) and
 * `highlight` (purple). Suggested mappings for integrations: effect read →
 * `info`, write → `warning`, destructive → `danger`; trust verified →
 * `success`, partner → `accent`, community → `neutral`; status installed →
 * `success`, update available → `info`.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children - The badge text.
 * @param {'neutral'|'info'|'success'|'warning'|'danger'|'accent'|'highlight'} [props.tone='neutral']
 * @param {'soft'|'outline'} [props.variant='soft'] - Tinted background, or a border only.
 * @param {'sm'|'md'} [props.size='sm'] - `sm` is the admin's `text-xs` pill.
 * @param {'pill'|'rounded'} [props.shape='pill'] - Fully rounded, or slightly rounded corners.
 * @param {React.ReactNode} [props.icon] - Decorative icon before the text (hidden from assistive technology).
 * @param {string} [props.className] - Extra classes (spacing, truncation).
 * @returns {JSX.Element}
 *
 * @example
 * <Badge tone="info" shape="rounded">{t('admin.features.preview', 'Preview')}</Badge>
 */
function Badge({
  children,
  tone = 'neutral',
  variant = 'soft',
  size = 'sm',
  shape = 'pill',
  icon,
  className = '',
  ...rest
}) {
  const variantKey = variant in VARIANT_BASE ? variant : 'soft';
  const toneClasses = (TONES[tone] || TONES.neutral)[variantKey];
  return (
    <span
      {...rest}
      className={`inline-flex items-center gap-1 font-medium ${SIZES[size] || SIZES.sm} ${
        SHAPES[shape] || SHAPES.pill
      } ${VARIANT_BASE[variantKey]} ${toneClasses} ${className}`}
    >
      {icon && (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}

export default Badge;
