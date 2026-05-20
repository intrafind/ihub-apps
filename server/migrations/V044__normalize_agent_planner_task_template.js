/**
 * Migration V044 — Normalize agent profile planner shape
 *
 * Earlier versions of the agent profile serializer wrote `taskTemplate` as
 * a nested `{ type: 'prompt', config: { ... } }` shape, and emitted planner
 * nodes without a `goal` field. The materializer then spread the wrapper
 * keys into the task node, producing `config.config` — which made deepMerge
 * recurse forever during state updates. Runtime patches in
 * `routes/agents/runs.js` and `agents/profile/profileWorkflowSerializer.js`
 * unwrap the broken shape and inject the missing goal on every run; those
 * runtime patches will be removed once this migration lands.
 *
 * For every file in `contents/agents/profiles/`:
 *
 *   1. Flatten `planner.config.taskTemplate.{type, config}` to a single flat
 *      taskTemplate object.
 *   2. Default `planner.config.goal` to `"${$.data.brief}"` when missing.
 *   3. Propagate `preferredModel`, `system`, `tools`, `apps`, `sources` from
 *      the Profile root into `planner.config.taskTemplate` (only fills holes;
 *      does not overwrite explicit values).
 *   4. Propagate `preferredModel` to `planner.config.modelId` when missing.
 *
 * Idempotent: a file that is already in canonical shape is left untouched.
 */

export const version = '044';
export const description = 'normalize_agent_planner_task_template';

export async function precondition(ctx) {
  return await ctx.fileExists('agents/profiles');
}

function flattenTaskTemplate(tt) {
  if (!tt || typeof tt !== 'object') return tt;
  // Old shape: { type: 'prompt', config: { ... }, ...extras }
  if (
    typeof tt.type === 'string' &&
    tt.config &&
    typeof tt.config === 'object' &&
    !Array.isArray(tt.config)
  ) {
    const { type: _t, config: inner, ...rest } = tt;
    return { ...rest, ...inner };
  }
  return tt;
}

function nonEmptyLocalized(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(v => typeof v === 'string' && v.trim().length > 0);
}

function normalizePlannerNode(node, profile) {
  if (!node || node.type !== 'planner') return { node, changed: false };
  const cfg = { ...(node.config || {}) };
  let changed = false;

  // Default goal
  if (!cfg.goal || (typeof cfg.goal === 'string' && cfg.goal.trim().length === 0)) {
    cfg.goal = '${$.data.brief}';
    changed = true;
  }

  // Flatten taskTemplate
  const tt = flattenTaskTemplate(cfg.taskTemplate);
  if (tt !== cfg.taskTemplate) {
    cfg.taskTemplate = tt;
    changed = true;
  }

  // Propagate fields from profile root into taskTemplate if missing
  if (cfg.taskTemplate && typeof cfg.taskTemplate === 'object') {
    const t = { ...cfg.taskTemplate };
    if (profile.preferredModel && !t.modelId) {
      t.modelId = profile.preferredModel;
      changed = true;
    }
    if (!t.system && nonEmptyLocalized(profile.system)) {
      t.system = profile.system;
      changed = true;
    }
    if (
      Array.isArray(profile.tools) &&
      profile.tools.length > 0 &&
      (!Array.isArray(t.tools) || t.tools.length === 0)
    ) {
      t.tools = [...profile.tools];
      changed = true;
    }
    if (
      Array.isArray(profile.apps) &&
      profile.apps.length > 0 &&
      (!Array.isArray(t.apps) || t.apps.length === 0)
    ) {
      t.apps = [...profile.apps];
      changed = true;
    }
    if (
      Array.isArray(profile.sources) &&
      profile.sources.length > 0 &&
      (!Array.isArray(t.sources) || t.sources.length === 0)
    ) {
      t.sources = [...profile.sources];
      changed = true;
    }
    cfg.taskTemplate = t;
  }

  // Propagate preferredModel to planner.config.modelId if missing
  if (profile.preferredModel && !cfg.modelId) {
    cfg.modelId = profile.preferredModel;
    changed = true;
  }

  return { node: { ...node, config: cfg }, changed };
}

export async function up(ctx) {
  let files;
  try {
    files = await ctx.listFiles('agents/profiles', '*.json');
  } catch (err) {
    ctx.warn(`Could not list agents/profiles: ${err.message}`);
    return;
  }

  if (!Array.isArray(files) || files.length === 0) {
    ctx.log('No agent profile files to migrate');
    return;
  }

  let migrated = 0;
  for (const file of files) {
    const profilePath = `agents/profiles/${file}`;
    let profile;
    try {
      profile = await ctx.readJson(profilePath);
    } catch (err) {
      ctx.warn(`Skipping ${profilePath}: ${err.message}`);
      continue;
    }

    const nodes = profile?.workflow?.definition?.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) {
      continue;
    }

    let fileChanged = false;
    const newNodes = nodes.map(n => {
      const { node, changed } = normalizePlannerNode(n, profile);
      if (changed) fileChanged = true;
      return node;
    });

    if (!fileChanged) continue;

    profile.workflow.definition.nodes = newNodes;
    try {
      await ctx.writeJson(profilePath, profile);
      migrated += 1;
      ctx.log(`Normalized ${profilePath}`);
    } catch (err) {
      ctx.warn(`Failed to write ${profilePath}: ${err.message}`);
    }
  }

  if (migrated === 0) {
    ctx.log('All agent profiles already in canonical shape');
  } else {
    ctx.log(`Normalized ${migrated} agent profile file(s)`);
  }
}
