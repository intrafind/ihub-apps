/**
 * Migration V045 — Re-ensure agent tools are registered in tools.json
 *
 * V042 registered the 8 agent tools (read_memory/write_memory/read_inbox/
 * write_inbox/create_task/list_tasks/mark_task_done/write_artifact). But some
 * installs ended up with a tools.json missing them — likely because the file
 * was hand-edited or copied from defaults after V042 ran. Without these
 * entries `getToolsForApp()` silently drops the agent tool ids when an agent
 * node tries to use them, the executor sees only the profile's explicit
 * tools (often just `webSearch`), and the model's `read_inbox`/`write_inbox`
 * calls hit the unregistered-tool allowlist trap.
 *
 * This migration re-asserts the registrations idempotently. Safe to apply
 * even if V042 already added them — `addIfMissing` matches by id.
 */

export const version = '045';
export const description = 'ensure_agent_tools_registered';

export async function precondition(ctx) {
  return await ctx.fileExists('config/tools.json');
}

export async function up(ctx) {
  const tools = await ctx.readJson('config/tools.json');
  if (!Array.isArray(tools)) {
    ctx.warn('config/tools.json is not an array; skipping');
    return;
  }
  let added = 0;
  for (const def of AGENT_TOOL_DEFINITIONS) {
    if (ctx.addIfMissing(tools, def)) added++;
  }
  if (added > 0) {
    await ctx.writeJson('config/tools.json', tools);
    ctx.log(`Re-registered ${added} agent tool(s) in config/tools.json`);
  } else {
    ctx.log('All agent tools already registered');
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
