// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The limits of user projects as Admin → Projects → Project settings edits
 * them (`platform.projects.limits`): what each input shows, and the values a
 * save sends.
 */

export const MB = 1024 * 1024;

/** English fallbacks of the label and the help of each limit. */
export const LIMIT_LABELS = {
  maxFiles: ['Items per project', 'Every kind of item counts. At most {{max}}.'],
  maxFileBytes: [
    'Size of one file (MB)',
    'An uploaded or picked file larger than this is refused.'
  ],
  maxProjectBytes: [
    'Size of one project (MB)',
    'The original sizes of the files in a project, added up.'
  ],
  maxProjectsPerUser: [
    'Projects per user',
    'Projects one person may own; 0 means no limit. Admin projects do not count.'
  ]
};

/**
 * The limits the panel edits: the bytes are shown in MB, the counts as they
 * are. `min` and `max` are what the server accepts (`max` in the shown unit;
 * `maxFiles` takes the ceiling the server sends instead).
 */
export const LIMIT_FIELDS = [
  { key: 'maxFiles', unit: 1, min: 1, decimals: false },
  { key: 'maxFileBytes', unit: MB, min: 1, max: Number.MAX_SAFE_INTEGER / MB, decimals: true },
  { key: 'maxProjectBytes', unit: MB, min: 1, max: Number.MAX_SAFE_INTEGER / MB, decimals: true },
  { key: 'maxProjectsPerUser', unit: 1, min: 0, max: 100_000, decimals: false }
];

/** A stored limit as the input shows it: bytes as MB (two decimals at most). */
export function limitToInput(value, unit) {
  if (!Number.isFinite(value)) return '';
  return String(unit === 1 ? value : Math.round((value / unit) * 100) / 100);
}

/**
 * The limits to send, from what the inputs hold. A field whose text is what it
 * showed when loaded keeps the stored value (no rounding of an odd byte
 * count); a field that is not a number in range lands in `invalid`.
 *
 * @param {Object<string, string>} inputs - The text of each input.
 * @param {Object<string, number>} stored - The limits as loaded.
 * @param {number} ceiling - The most items a project may hold.
 * @returns {{values: Object<string, number>, invalid: string[]}}
 */
export function parseLimits(inputs, stored, ceiling) {
  const values = {};
  const invalid = [];
  for (const { key, unit, min, max: fieldMax, decimals } of LIMIT_FIELDS) {
    const text = String(inputs[key] ?? '').trim();
    if (text === limitToInput(stored[key], unit)) {
      values[key] = stored[key];
      continue;
    }
    const number = Number(text);
    const max = key === 'maxFiles' ? ceiling : fieldMax;
    if (
      text === '' ||
      !Number.isFinite(number) ||
      (!decimals && !Number.isInteger(number)) ||
      number < min ||
      number > max ||
      Math.round(number * unit) < min
    ) {
      invalid.push(key);
      continue;
    }
    values[key] = Math.round(number * unit);
  }
  return { values, invalid };
}

/** The text of each limit input, from the stored limits. */
export const limitInputsOf = limits =>
  Object.fromEntries(LIMIT_FIELDS.map(({ key, unit }) => [key, limitToInput(limits?.[key], unit)]));
