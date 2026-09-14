import { z } from 'zod';
import { zSafeId } from './common.js';

export const groupConfigSchema = z
  .object({
    id: zSafeId.min(1),
    name: z.string().min(1, 'Group name is required'),
    description: z.string().optional(),
    permissions: z
      .object({
        apps: z.array(z.string()).prefault([]),
        prompts: z.array(z.string()).prefault([]),
        models: z.array(z.string()).prefault([]),
        workflows: z.array(z.string()).prefault([]),
        skills: z.array(z.string()).prefault([]),
        // Direct tool access over the MCP/A2A gateways. Empty by default:
        // a chat app's own `tools` list is what grants tool use in chat.
        tools: z.array(z.string()).prefault([]),
        adminAccess: z.boolean().prefault(false),
        // Content administration (apps, prompts, sources) without full admin
        // rights — see `middleware/contentAdminAuth.js`. Every permission
        // `utils/authorization.js` reads belongs here, or the admin editor
        // rejects a group that merely uses it.
        contentAdmin: z.boolean().prefault(false)
      })
      .prefault({}),
    mappings: z.array(z.string()).prefault([]),
    inherits: z.array(z.string()).optional(),
    enabled: z.boolean().prefault(true)
  })
  .passthrough();

export const knownGroupKeys = Object.keys(groupConfigSchema.shape);
