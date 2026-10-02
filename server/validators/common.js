import { z } from 'zod';
import { SAFE_ID_PATTERN } from '../utils/pathSecurity.js';

export const zSafeId = z
  .string()
  .regex(
    SAFE_ID_PATTERN,
    'ID must contain only alphanumeric characters, underscores, dots, and hyphens'
  );

/**
 * Whether `value` parses as an absolute URL with the `http:` or `https:` scheme.
 *
 * `z.string().url()` on its own accepts any scheme `new URL()` can parse,
 * including `javascript:` and `data:`.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A URL string limited to the `http:` and `https:` schemes. Use it for URLs the
 * client navigates to or renders as a link or frame, so a configured value can
 * only ever point at a web page.
 *
 * @param {string} [label='URL'] - Field name used in the validation messages.
 * @returns {import('zod').ZodType<string>}
 *
 * @example
 * const redirectConfigSchema = z.object({ url: zHttpUrl('Redirect URL') });
 */
export const zHttpUrl = (label = 'URL') =>
  z
    .string()
    .url(`${label} must be a valid URL`)
    .refine(isHttpUrl, { message: `${label} must use http or https` });
