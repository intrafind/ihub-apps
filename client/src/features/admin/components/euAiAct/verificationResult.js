// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Turns an answer of `POST /api/eu-ai-act/provenance/_verify` into rows and a headline.
 *
 * One row per technique, each with its own verdict, never one boolean. The
 * wording rules (README decision 8): a negative is never proof of origin, and
 * "too short" or "detector not reachable" is no conclusion, not a negative.
 *
 * Row `status`: `found` (positive), `notFound` (negative), `inconclusive`, or
 * `info` (nothing to conclude: not checked, declared only).
 *
 * @param {Object} result - The response body
 * @returns {{headline: 'match'|'none'|'inconclusive', rows: Array<Object>, caveats: string[]}}
 */
export function summarizeVerification(result) {
  const rows = [];
  const isMedia = Boolean(result.contentHash);

  const record = result.records?.[0];
  rows.push({
    id: 'record',
    status: result.found ? 'found' : 'notFound',
    createdAt: record?.created_at || record?.createdAt || null,
    modelId: record?.model?.id || null
  });

  if (!isMedia) {
    const watermark = result.watermark;
    if (watermark) {
      const map = {
        detected: 'found',
        not_detected: 'notFound',
        too_short: 'inconclusive',
        unavailable: 'inconclusive',
        not_configured: 'info'
      };
      rows.push({
        id: 'watermark',
        status: map[watermark.status] || 'info',
        state: watermark.status,
        keyId: watermark.keyId || null,
        pValue: watermark.pValue ?? null,
        scoredTokens: watermark.scoredTokens ?? null,
        keysChecked: watermark.keysChecked ?? null,
        technique: watermark.technique || watermark.scheme || null
      });
    } else {
      rows.push({ id: 'watermark', status: 'info', state: 'skipped' });
    }
  } else {
    const c2pa = result.c2pa;
    if (!c2pa) {
      rows.push({ id: 'c2pa', status: 'info', state: 'skipped' });
    } else if (c2pa.present || c2pa.status === 'present') {
      rows.push({
        id: 'c2pa',
        status: 'found',
        state: 'present',
        valid: c2pa.valid === true,
        issuer: c2pa.issuer || null,
        digitalSourceType: c2pa.digitalSourceType || c2pa.xmpDigitalSourceType || null
      });
    } else if (c2pa.status === 'absent') {
      rows.push({ id: 'c2pa', status: 'notFound', state: 'absent' });
    } else {
      rows.push({ id: 'c2pa', status: 'inconclusive', state: c2pa.status || 'unreadable' });
    }
    if (result.synthid === 'declared-not-detectable') {
      rows.push({ id: 'synthid', status: 'info', state: 'declared' });
    }
  }

  const positive = rows.some(row => row.status === 'found');
  const inconclusive = rows.some(row => row.status === 'inconclusive');
  return {
    headline: positive ? 'match' : inconclusive ? 'inconclusive' : 'none',
    rows,
    caveats: Array.isArray(result.caveats) ? result.caveats : []
  };
}
