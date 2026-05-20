import { z } from 'zod';

const INBOX_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*[a-z0-9]$/;

export const agentInboxFrontmatterSchema = z.object({
  inboxId: z
    .string()
    .regex(
      INBOX_ID_PATTERN,
      'Inbox ID must be lowercase alphanumeric (hyphens/underscores allowed)'
    )
    .min(1)
    .max(64),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
  version: z.number().int().min(0).optional().default(0)
});

export const agentInboxItemSchema = z.object({
  line: z.number().int().min(0),
  raw: z.string(),
  priority: z.enum(['p1', 'p2', 'p3', 'unprioritized']).optional().default('unprioritized'),
  text: z.string(),
  status: z.enum(['open', 'done']),
  note: z.string().optional()
});

export { INBOX_ID_PATTERN };
