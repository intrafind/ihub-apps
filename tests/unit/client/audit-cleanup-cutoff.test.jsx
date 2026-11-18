// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The audit cleanup confirmation names the UTC date the server cuts at
 * (AuditLogService names daily files by UTC date), not the local date.
 */
import { auditCleanupCutoffLabel } from '../../../client/src/features/admin/utils/auditCleanupCutoff';

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

test.each([
  // UTC+14: 00:30 UTC is already the afternoon of the same local day — and
  // 23:30 UTC is the next local day; the label must follow UTC either way.
  ['Pacific/Kiritimati', Date.UTC(2026, 10, 17, 23, 30), '2026-10-18'],
  // UTC−10: 00:30 UTC is still the previous local evening.
  ['Pacific/Honolulu', Date.UTC(2026, 10, 17, 0, 30), '2026-10-18']
])('in %s the label is the UTC cut-off date', (tz, now, expected) => {
  process.env.TZ = tz;
  expect(auditCleanupCutoffLabel(30, now, 'en-CA')).toBe(expected);
  // What the server compares against.
  expect(new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)).toBe(expected);
});
