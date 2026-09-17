/**
 * Build a safe `Content-Disposition: attachment` header value for a
 * user-supplied filename.
 *
 * The naive form `attachment; filename="${name}"` is vulnerable to
 * header injection when `name` contains `"`, `\`, `\r`, or `\n`, and
 * silently breaks on non-ASCII filenames. This helper emits both an
 * ASCII-safe `filename` (fallback for old clients) and an RFC 5987
 * `filename*=UTF-8''…` (per RFC 6266 §5) so the value can't escape the
 * quoted string and any client can recover the real name.
 *
 * @param {string} name — proposed filename. Falsy values fall back to
 *   `'download'`.
 * @returns {string} a complete header value, ready for `res.setHeader`.
 */
export function buildContentDisposition(name) {
  const raw = name && typeof name === 'string' ? name : 'download';
  const asciiFallback = raw.replace(/[^\x20-\x7E]/g, '_').replace(/["\\\r\n]/g, '_');
  const utf8Encoded = encodeURIComponent(raw);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

export default buildContentDisposition;
