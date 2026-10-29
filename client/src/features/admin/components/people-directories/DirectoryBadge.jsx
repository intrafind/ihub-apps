// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import Icon from '../../../../shared/components/Icon';

const TONES = {
  neutral:
    'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 border-gray-200 dark:border-gray-600',
  info: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-800',
  success:
    'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 border-green-200 dark:border-green-800',
  warning:
    'bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200 border-amber-300 dark:border-amber-700',
  danger:
    'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-200 dark:border-red-800'
};

/**
 * A small pill for the state of a directory or certificate ("Plain text",
 * "External", "Expires in 30 days"). Colour is never the only signal: every
 * badge carries its meaning as text, and an optional icon repeats it.
 *
 * @param {Object} props
 * @param {'neutral'|'info'|'success'|'warning'|'danger'} [props.tone='neutral']
 * @param {string} [props.icon] - Icon name from the shared Icon component
 * @param {string} [props.title] - Longer explanation shown on hover
 * @param {React.ReactNode} props.children - Badge text
 */
function DirectoryBadge({ tone = 'neutral', icon, title, children }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${TONES[tone] ?? TONES.neutral}`}
    >
      {icon && <Icon name={icon} size="xs" className="shrink-0" />}
      {children}
    </span>
  );
}

export default DirectoryBadge;
