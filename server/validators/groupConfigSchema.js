// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { usageLimitsSchema, zSafeId } from './common.js';

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
        // Installed integrations members may use (#3093): `*`, installation
        // ids (`x500bund`), definition ids (`com.intrafind/ldap-directory`)
        // and type keys (`type:people-directory`). Checked on top of every
        // app binding — see `services/integrations/integrationAccess.js`.
        integrations: z.array(z.string()).prefault([]),
        adminAccess: z.boolean().prefault(false),
        // Content administration (apps, prompts, sources) without full admin
        // rights — see `middleware/contentAdminAuth.js`. Every permission
        // `utils/authorization.js` reads belongs here, or the admin editor
        // rejects a group that merely uses it.
        contentAdmin: z.boolean().prefault(false),
        // May create and run scheduled tasks (feature `scheduledTasks`).
        scheduledTasks: z.boolean().prefault(false),
        // May create projects of their own (feature `userProjects`, #1036).
        projects: z.boolean().prefault(false),
        // May add members to the projects they own or edit.
        projectSharing: z.boolean().prefault(false)
      })
      .prefault({}),
    mappings: z.array(z.string()).prefault([]),
    inherits: z.array(z.string()).optional(),
    // Token and file storage limits of the members (services/quota).
    usageLimits: usageLimitsSchema.optional(),
    enabled: z.boolean().prefault(true)
  })
  .passthrough();

export const knownGroupKeys = Object.keys(groupConfigSchema.shape);
