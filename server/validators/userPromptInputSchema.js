import { z } from 'zod';

/**
 * Validates the create/update payload for a user-owned prompt (see
 * server/utils/userPromptsStore.js). Deliberately simpler than
 * promptConfigSchema.js: user prompts aren't localized and carry no
 * variables/actions/outputSchema — those remain admin-curated-only for now.
 */
export const userPromptInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200, 'Name is too long'),
    description: z.string().trim().max(2000, 'Description is too long').optional().default(''),
    prompt: z.string().trim().min(1, 'Prompt text is required').max(20000, 'Prompt is too long'),
    category: z.string().trim().max(100, 'Category is too long').optional(),
    visibility: z.enum(['private', 'shared']).optional().default('private')
  })
  .strict();
