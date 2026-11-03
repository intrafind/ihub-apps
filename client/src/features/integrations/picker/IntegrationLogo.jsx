// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import Icon from '../../../shared/components/Icon';

/**
 * The logo of a picker row: the integration's icon (an http(s) URL the server
 * names), else the first letter of its name. Decorative: the name is always
 * next to it.
 *
 * @param {Object} props
 * @param {{icon?: string|null, kind?: string, name?: string}} props.row
 * @param {'sm'|'md'} [props.size='md']
 */
export default function IntegrationLogo({ row, size = 'md' }) {
  const box = size === 'sm' ? 'h-4 w-4 text-[9px]' : 'h-6 w-6 text-xs';
  if (row?.icon) {
    return (
      <img src={row.icon} alt="" aria-hidden="true" className={`${box} rounded object-contain`} />
    );
  }
  if (row?.kind === 'websearch') {
    return <Icon name="globe-alt" size={size === 'sm' ? 'xs' : 'sm'} aria-hidden="true" />;
  }
  const letter = String(row?.name || '?')
    .trim()
    .charAt(0)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`${box} inline-flex shrink-0 items-center justify-center rounded bg-indigo-100 font-semibold text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300`}
    >
      {letter}
    </span>
  );
}
