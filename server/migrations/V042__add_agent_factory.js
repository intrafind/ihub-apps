/**
 * Migration V042 — Agent Factory V1 foundation
 *
 * Adds the directory layout and default groups for the agent factory.
 * Idempotent: safe to run multiple times.
 *
 *  - Ensures `contents/agents/profiles/` exists.
 *  - Ensures `contents/agents/memory/` exists.
 *  - Ensures `contents/data/agent-inboxes/` exists.
 *  - Ensures `contents/data/agent-artifacts/` exists.
 *  - Adds `agents` and `agent-operators` groups to groups.json if absent.
 *  - Adds `features.appAsTool` (default false) and `features.agentFactory`
 *    (default true) to platform.json.
 */

import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../pathUtils.js';

export const version = '042';
export const description = 'add_agent_factory';

async function ensureDir(relative) {
  const abs = path.join(getRootDir(), 'contents', relative);
  await fs.mkdir(abs, { recursive: true });
}

export async function precondition(_ctx) {
  // Always run — directory creation is idempotent.
  return true;
}

export async function up(ctx) {
  // ── 1. Ensure required directories ────────────────────────────────────────
  await ensureDir('agents/profiles');
  await ensureDir('agents/memory');
  await ensureDir('data/agent-inboxes');
  await ensureDir('data/agent-artifacts');
  ctx.log('Created agent factory directories');

  // ── 2. Add agents + agent-operators groups to groups.json ─────────────────
  if (await ctx.fileExists('config/groups.json')) {
    const groupsConfig = await ctx.readJson('config/groups.json');
    if (!groupsConfig.groups) groupsConfig.groups = {};

    let changed = false;
    if (!groupsConfig.groups.agents) {
      groupsConfig.groups.agents = {
        id: 'agents',
        name: 'Agents',
        description: 'Service-account group for agent runs',
        inherits: ['authenticated'],
        permissions: {
          apps: [],
          prompts: [],
          models: ['*'],
          skills: [],
          adminAccess: false
        },
        mappings: []
      };
      changed = true;
      ctx.log('Added agents group');
    }
    if (!groupsConfig.groups['agent-operators']) {
      groupsConfig.groups['agent-operators'] = {
        id: 'agent-operators',
        name: 'Agent Operators',
        description: 'Users who can trigger agent runs and approve HITL checkpoints',
        inherits: ['authenticated'],
        permissions: {
          apps: ['*'],
          prompts: ['*'],
          models: ['*'],
          skills: ['*'],
          adminAccess: false
        },
        mappings: []
      };
      changed = true;
      ctx.log('Added agent-operators group');
    }
    if (changed) {
      await ctx.writeJson('config/groups.json', groupsConfig);
    } else {
      ctx.log('Agent groups already present — skipping');
    }
  }

  // ── 3. Add platform feature flags ─────────────────────────────────────────
  if (await ctx.fileExists('config/platform.json')) {
    const platform = await ctx.readJson('config/platform.json');
    let changed = false;
    if (ctx.setDefault(platform, 'features.agentFactory', true)) changed = true;
    if (ctx.setDefault(platform, 'features.appAsTool', false)) changed = true;
    if (changed) {
      await ctx.writeJson('config/platform.json', platform);
      ctx.log('Added agentFactory + appAsTool feature flags to platform.json');
    } else {
      ctx.log('Agent feature flags already present — skipping');
    }
  }

  // ── 4. Register agent tools in config/tools.json ──────────────────────────
  if (await ctx.fileExists('config/tools.json')) {
    const tools = await ctx.readJson('config/tools.json');
    if (Array.isArray(tools)) {
      let added = 0;
      for (const def of AGENT_TOOL_DEFINITIONS) {
        if (ctx.addIfMissing(tools, def)) added++;
      }
      if (added > 0) {
        await ctx.writeJson('config/tools.json', tools);
        ctx.log(`Registered ${added} agent tool(s) in config/tools.json`);
      } else {
        ctx.log('Agent tools already registered — skipping');
      }
    }
  }
}

const AGENT_TOOL_DEFINITIONS = [
  {
    id: 'read_memory',
    name: { en: 'Read Memory' },
    description: {
      en: 'Read your long-term memory file. Returns the full body and current version.'
    },
    script: 'agentTools.js',
    method: 'readMemory',
    isAgentTool: true,
    parameters: { type: 'object', properties: {} }
  },
  {
    id: 'write_memory',
    name: { en: 'Write Memory' },
    description: {
      en: "Append or replace the contents of your long-term memory file. Use mode='append' for adding notes, 'replace' for full rewrite. Provide expectedVersion to avoid clobbering concurrent writes."
    },
    script: 'agentTools.js',
    method: 'writeMemory',
    isAgentTool: true,
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['append', 'replace'], default: 'append' },
        content: { type: 'string', description: 'The markdown content to write' },
        summary: { type: 'string', description: 'Optional one-line summary of what changed' },
        expectedVersion: {
          type: 'integer',
          description: 'Expected version for optimistic concurrency'
        }
      },
      required: ['content']
    }
  },
  {
    id: 'read_inbox',
    name: { en: 'Read Inbox' },
    description: {
      en: 'Read the items in your bound inbox. Optionally filter by status (open/done/all).'
    },
    script: 'agentTools.js',
    method: 'readInbox',
    isAgentTool: true,
    parameters: {
      type: 'object',
      properties: {
        inboxId: {
          type: 'string',
          description: 'Override inbox id (defaults to your profile inbox)'
        },
        status: { type: 'string', enum: ['open', 'done', 'all'], default: 'all' }
      }
    }
  },
  {
    id: 'write_inbox',
    name: { en: 'Write Inbox' },
    description: {
      en: "Update an inbox. mode='add' appends a new item; 'markDone' marks an existing item done by matching its text; 'replace' rewrites the full body."
    },
    script: 'agentTools.js',
    method: 'writeInbox',
    isAgentTool: true,
    parameters: {
      type: 'object',
      properties: {
        inboxId: { type: 'string' },
        mode: { type: 'string', enum: ['add', 'markDone', 'replace'] },
        item: { type: 'string', description: 'The text of the item (for add or markDone)' },
        priority: { type: 'string', enum: ['p1', 'p2', 'p3'] },
        body: { type: 'string', description: 'Full markdown body for replace mode' },
        note: { type: 'string', description: 'Optional completion note for markDone' },
        expectedVersion: { type: 'integer' }
      },
      required: ['mode']
    }
  },
  {
    id: 'create_task',
    name: { en: 'Create Task' },
    description: {
      en: 'Enqueue a new task on the run task queue. The drain loop will process it. Refused if depth would exceed dynamicTasks.maxDepth.'
    },
    script: 'agentTools.js',
    method: 'createTask',
    isAgentTool: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title' },
        brief: { type: 'string', description: 'Longer description / instructions' },
        priority: { type: 'string', enum: ['p1', 'p2', 'p3'], default: 'p2' }
      },
      required: ['title']
    }
  },
  {
    id: 'list_tasks',
    name: { en: 'List Tasks' },
    description: { en: 'List tasks currently on the queue. Filter by status / limit.' },
    script: 'agentTools.js',
    method: 'listTasks',
    isAgentTool: true,
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'failed'] },
        limit: { type: 'integer' }
      }
    }
  },
  {
    id: 'mark_task_done',
    name: { en: 'Mark Task Done' },
    description: { en: 'Explicitly mark a task as done with an optional result.' },
    script: 'agentTools.js',
    method: 'markTaskDone',
    isAgentTool: true,
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        result: { description: 'Arbitrary completion payload' }
      },
      required: ['taskId']
    }
  },
  {
    id: 'write_artifact',
    name: { en: 'Write Artifact' },
    description: {
      en: 'Persist an artifact file to the current run output directory. Returns when saved.'
    },
    script: 'agentTools.js',
    method: 'writeArtifact',
    isAgentTool: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Simple filename (no slashes)' },
        content: { type: 'string', description: 'File contents' },
        contentType: { type: 'string', default: 'text/markdown' }
      },
      required: ['name', 'content']
    }
  }
];
