import { z } from 'zod';

/**
 * Schema for a single audit-log entry.
 *
 * `action`, `result`, and `source` are constrained to known enums. `resource`
 * is intentionally a free-form string: the global audit middleware derives
 * resource names from request paths, so the set is open-ended.
 */
export const auditActions = [
  'create',
  'update',
  'delete',
  'toggle',
  'import',
  'export',
  'login',
  'logout'
];

export const auditResults = ['success', 'failure'];

export const auditSources = ['web', 'mcp', 'api', 'admin'];

export const auditActorSchema = z.object({
  id: z.string().min(1),
  username: z.string(),
  groups: z.array(z.string()).default([]),
  authenticated: z.boolean()
});

export const auditEntrySchema = z.object({
  id: z.string().uuid(),
  ts: z.string().datetime(),
  actor: auditActorSchema,
  action: z.enum(auditActions),
  resource: z.string().min(1),
  resourceId: z.string().default(''),
  summary: z.string().default(''),
  result: z.enum(auditResults).default('success'),
  source: z.enum(auditSources).default('web'),
  requestId: z.string().optional(),
  // `null` is a valid value: when `audit.anonymizeIp: "drop"` the recorder
  // explicitly drops the IP to null so the field is preserved for log shape
  // consistency but contains no PII.
  ip: z.string().nullable().optional()
});

/**
 * Validate an audit entry. Returns `{ success, error }` and never throws so it
 * can be used as a warn-and-still-write gate.
 *
 * @param {Object} entry
 * @returns {{ success: boolean, error?: string }}
 */
export function validateAuditEntry(entry) {
  const result = auditEntrySchema.safeParse(entry);
  if (result.success) return { success: true };
  return {
    success: false,
    error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
  };
}
