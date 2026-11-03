// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** Tile colours for integrations without an icon, picked by a hash of the id. */
const TILE_COLOURS = [
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200',
  'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
  'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200',
  'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200',
  'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200'
];

function colourOf(id) {
  let hash = 0;
  for (const char of String(id || '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TILE_COLOURS[hash % TILE_COLOURS.length];
}

/**
 * The logo of an integration: its icon URL (`entry.icon`, http(s) only), else
 * a tile with its initial. Decorative — the name is always next to it.
 *
 * @param {Object} props
 * @param {{id: string, name?: string, icon?: string|null}} props.entry
 * @param {'sm'|'md'} [props.size='md']
 */
export default function IntegrationLogo({ entry, size = 'md' }) {
  const box = size === 'sm' ? 'h-6 w-6 text-xs' : 'h-10 w-10 text-base';
  if (entry?.icon) {
    return (
      <img
        src={entry.icon}
        alt=""
        aria-hidden="true"
        className={`${box} shrink-0 rounded-lg bg-white object-contain p-1 ring-1 ring-gray-200 dark:ring-gray-700`}
        referrerPolicy="no-referrer"
      />
    );
  }
  const initial = String(entry?.name || entry?.id || '?')
    .trim()
    .charAt(0)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`${box} ${colourOf(entry?.id)} inline-flex shrink-0 items-center justify-center rounded-lg font-semibold`}
    >
      {initial}
    </span>
  );
}
