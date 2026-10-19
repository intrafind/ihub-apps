// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V166 — Every workflow end step gets an `output`
 *
 * Every end step now has an `output`: the answer a chat shows as it is (and what
 * an API, MCP or A2A caller receives), with whatever else the end step passes
 * on as additional information next to it. Before, the answer of a workflow was
 * picked from its whole result: the `chatIntegration.primaryOutput` it named,
 * else the first of a list of conventional names (`finalReport`, `report`, …),
 * else a dump of everything as JSON. `primaryOutput` is gone, and so is the
 * guessing.
 *
 * What is changed, in every workflow of `workflows/*.json` (and of the legacy
 * `config/workflows.json`):
 *   - Each end step without an `output` gets one, in this order:
 *       1. the workflow's `chatIntegration.primaryOutput`. For an end step with an
 *          `outputMapping` it is translated through the mapping to what the key
 *          maps to; otherwise it names a variable (or a path into one) as it did
 *       2. the first conventional answer name the end step passes on, in the
 *          order the chat looked for them
 *       3. for the workflows that shipped with iHub, the answer of that end step
 *          (SHIPPED_OUTPUTS), for those whose answer has no conventional name
 *       4. otherwise an object of what the end step passes on, one field per
 *          variable: `{ "topic": "topic", "report": "notes" }`. That is what a
 *          workflow without a named answer gave before: everything it passed on, as
 *          one JSON object, which a caller still gets as JSON
 *   - `chatIntegration.primaryOutput` is removed, and so is
 *     `chatIntegration.passthroughResult`, which no code ever read: the answer is
 *     always shown as it is.
 *
 * What is left alone: an end step that already has an `output`, a workflow
 * without end steps, and files that cannot be read.
 *
 * What needs an admin: an end step that passes on nothing that can be named, or
 * maps a key to a literal rather than to a `$.` path (also when that key is the
 * `primaryOutput`), and an end step that passes on every variable of a workflow
 * with a planner, a memory or inbox finalizer or a quote validator, whose
 * variables cannot all be listed. It is listed in the log and
 * left without an `output`. The workflow still loads, and a run that reaches that
 * end step fails with a message that names the step; saving the workflow in the
 * editor asks for the output. Set the end step's Output to the variable that holds
 * the answer.
 *
 * Running it again changes nothing: every end step it could resolve has an
 * `output` by then, and the ones it could not are listed again.
 */

export const version = '166';
export const description = 'workflow_end_step_output';

/**
 * The names the chat looked for as the answer of a workflow, in the order it
 * looked (`CHAT_OUTPUT_FALLBACK_FIELDS` of shared/workflowChatOutput.js as of
 * V166). Do NOT replace with an import: the chat no longer looks for any, and a
 * migration must not change with the application.
 */
const CONVENTIONAL_ANSWER_NAMES = [
  'finalReport',
  'report',
  'content',
  'output',
  'result',
  'summary',
  'text',
  'message'
];

/**
 * The answer of the end steps of the workflows that shipped with iHub and whose
 * answer has no conventional name, as set in `server/defaults/workflows/`.
 * Keyed by workflow id, then end step id. Snapshot as of V166.
 */
const SHIPPED_OUTPUTS = {
  'approval-workflow': { 'end-rejected': 'Rejected: {{topic}}' },
  'claude-style-agent': { end: 'draft' },
  'claude-style-agent-phased': { end: 'draft' },
  'knowledge-qa': { end: 'answer' }
};

/**
 * The top-level keys of the run state a `$.` path can start at: what
 * `StateManager.create()` gives a run, and the `nodeOutputs`, `metadata` and
 * `executedNodes` the documentation names. Variables live under `data`.
 */
const STATE_ROOTS = new Set([
  'data',
  'executionId',
  'workflowId',
  'status',
  'currentNodes',
  'completedNodes',
  'failedNodes',
  'history',
  'checkpoints',
  'errors',
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
  'nodeOutputs',
  'metadata',
  'executedNodes'
]);

/**
 * Step types whose writes to the run state are not all named by their
 * configuration: the variables of a workflow that has one cannot be listed.
 */
const UNLISTABLE_TYPES = new Set([
  'planner',
  'memory-finalize',
  'inbox-finalize',
  'quote-validator'
]);

/** The legacy single file holding all workflows as an array. */
const LEGACY_FILE = 'config/workflows.json';

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim() !== '';
/** An output is set when it is a text, or an object with at least one field. */
const hasOutput = value => isText(value) || (isPlainObject(value) && Object.keys(value).length > 0);

const keysOf = value => (isPlainObject(value) ? Object.keys(value) : []);

/**
 * The variables each type of step defines beyond its `outputVariable`, as the
 * visual editor lists them (`variablesProducedBy()` as of V166). Do NOT replace
 * with an import: a migration must not change with the application.
 */
const PRODUCED_BY_TYPE = {
  start: config => [
    ...(Array.isArray(config.inputVariables) ? config.inputVariables.map(item => item?.name) : []),
    ...keysOf(config.defaults),
    ...keysOf(config.inputMapping)
  ],
  loop: config => [config.countInto],
  'corpus-search': config => [config.corpusVar || '_corpus', config.coverageVar || '_coverage'],
  'structured-record': config => [config.recordsVar || '_records'],
  'query-plan': config => [config.outputVar || '_queryPlan'],
  'template-render': config => [config.reportVar],
  'inbox-load': config => [config.outputVariable || 'currentInboxItem'],
  human: (config, node) => [config.outputVariable || `humanResponse_${node.id}`],
  verifier: () => ['verificationResult'],
  // A transform names its destination under `to`, `set`, `into` or `increment`
  transform: config =>
    (Array.isArray(config.operations) ? config.operations : []).flatMap(operation =>
      isPlainObject(operation)
        ? [operation.to, operation.set, operation.into, operation.increment]
        : []
    )
};

/**
 * The variables the workflow's steps write, for an end step that passes on
 * every variable and so does not name them. `complete` is false when a step
 * writes more than its configuration names, and the list falls short.
 *
 * @returns {{names: Set<string>, complete: boolean}}
 */
function writtenVariables(workflow) {
  const names = new Set();
  let complete = true;

  const visit = nodes => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!isPlainObject(node)) continue;
      const config = isPlainObject(node.config) ? node.config : {};
      if (UNLISTABLE_TYPES.has(node.type)) complete = false;
      for (const name of [
        config.outputVariable,
        ...(PRODUCED_BY_TYPE[node.type]?.(config, node) ?? [])
      ]) {
        // A path into a variable writes that variable
        if (isText(name)) names.add(name.trim().split('.')[0]);
      }
      // A loop can hold its steps inline
      visit(config.body);
    }
  };
  visit(workflow.nodes);
  return { names, complete };
}

/**
 * What an end step passes on, as the end step builds its output: its mapping,
 * else its included fields, else everything but its excluded fields, else its
 * listed variables, else every variable. When that is every variable and the
 * workflow has a step whose writes cannot be listed, it is `unknown`.
 *
 * @returns {{mapping: Object}|{names: string[]}|{unknown: true}}
 */
function passedOn(workflow, endNode) {
  const config = endNode.config || {};
  if (isPlainObject(config.outputMapping)) return { mapping: config.outputMapping };
  if (Array.isArray(config.includeFields)) return { names: config.includeFields };
  if (Array.isArray(config.outputVariables) && !Array.isArray(config.excludeFields)) {
    return { names: config.outputVariables };
  }

  const written = writtenVariables(workflow);
  if (!written.complete) return { unknown: true };
  const excluded = new Set(Array.isArray(config.excludeFields) ? config.excludeFields : []);
  return { names: [...written.names].filter(name => !excluded.has(name)) };
}

/**
 * What a mapped key maps to, as an end step output: only a `$.` path can be one.
 * A path that does not start at a part of the run state, `$.finalReport`, never
 * found anything, because variables live under `data`: it means the variable.
 */
function mappedSource(mapping, key, restPath = '') {
  const source = mapping[key];
  if (typeof source !== 'string' || !source.trim().startsWith('$')) return null;
  const path = source.trim().replace(/^\$\.?/, '') + restPath;
  const root = path.split('.')[0].replace(/\[\d+\]$/, '');
  return STATE_ROOTS.has(root) ? `$.${path}` : path;
}

/**
 * The output for an end step that has none, or null when no rule tells it.
 */
function outputFor(workflow, endNode) {
  const passed = passedOn(workflow, endNode);
  const primary = isText(workflow.chatIntegration?.primaryOutput)
    ? workflow.chatIntegration.primaryOutput.trim()
    : null;

  // 1. The primary output the workflow named. For a mapped end step it named a
  //    key of the mapping, which is what its output was looked up by.
  if (primary) {
    const [key, ...rest] = primary.split('.');
    if (passed.mapping && Object.hasOwn(passed.mapping, key)) {
      // Null when the key maps to a literal, which no output can say: an admin sets it
      return mappedSource(passed.mapping, key, rest.map(part => `.${part}`).join(''));
    }
    return primary;
  }

  // 2. The first conventional answer name the end step passes on. An end step
  //    that passes on everything of a workflow whose variables cannot all be
  //    listed is left to an admin: the name found may not be the first there is.
  const names = passed.mapping ? Object.keys(passed.mapping) : (passed.names ?? []);
  const present = new Set(names.filter(isText).map(name => name.trim()));
  for (const name of CONVENTIONAL_ANSWER_NAMES) {
    if (!present.has(name)) continue;
    if (!passed.mapping) return name;
    const source = mappedSource(passed.mapping, name);
    if (source) return source;
  }

  // 3. The answer of a shipped workflow that names it unconventionally.
  const shipped = SHIPPED_OUTPUTS[workflow.id]?.[endNode.id];
  if (shipped) return shipped;

  // 4. Everything the end step passes on, as one object: what it gave before.
  return objectOf(passed);
}

/**
 * An output object with a field for each thing an end step passes on, or null
 * when there is none, or when one of them cannot be said as an output (a mapped
 * key that maps to a literal).
 */
function objectOf(passed) {
  if (passed.unknown) return null;
  const fields = {};
  if (passed.mapping) {
    for (const key of Object.keys(passed.mapping)) {
      const source = mappedSource(passed.mapping, key);
      if (!source) return null;
      fields[key] = source;
    }
  } else {
    for (const name of passed.names.filter(isText).map(text => text.trim())) fields[name] = name;
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

/**
 * Give the end steps of `workflow` their output and drop `primaryOutput`.
 *
 * @returns {{changed: boolean, set: number, unresolved: string[]}}
 */
function migrateWorkflow(workflow) {
  let changed = false;
  let set = 0;
  const unresolved = [];
  const objects = [];

  for (const node of Array.isArray(workflow.nodes) ? workflow.nodes : []) {
    if (node?.type !== 'end' || hasOutput(node.config?.output)) continue;
    const output = outputFor(workflow, node);
    if (output) {
      node.config = { ...(node.config || {}), output };
      changed = true;
      set += 1;
      if (isPlainObject(output)) objects.push(node.id);
    } else {
      unresolved.push(node.id);
    }
  }

  if (isPlainObject(workflow.chatIntegration)) {
    for (const removed of ['primaryOutput', 'passthroughResult']) {
      if (removed in workflow.chatIntegration) {
        delete workflow.chatIntegration[removed];
        changed = true;
      }
    }
  }
  return { changed, set, unresolved, objects };
}

export async function precondition(ctx) {
  return (
    (await ctx.listFiles('workflows', '*.json')).length > 0 || (await ctx.fileExists(LEGACY_FILE))
  );
}

export async function up(ctx) {
  let workflows = 0;
  let endSteps = 0;
  const needAdmin = [];
  const asObject = [];

  const record = (workflow, result) => {
    if (result.set > 0) workflows += 1;
    endSteps += result.set;
    for (const nodeId of result.unresolved) needAdmin.push(`${workflow.id || '?'} (${nodeId})`);
    for (const nodeId of result.objects) asObject.push(`${workflow.id || '?'} (${nodeId})`);
  };

  for (const file of await ctx.listFiles('workflows', '*.json')) {
    const relativePath = `workflows/${file}`;
    let workflow;
    try {
      workflow = await ctx.readJson(relativePath);
    } catch (error) {
      ctx.warn(`Skipped ${relativePath}: ${error.message}`);
      continue;
    }
    if (!isPlainObject(workflow)) continue;
    const result = migrateWorkflow(workflow);
    record(workflow, result);
    if (result.changed) await ctx.writeJson(relativePath, workflow);
  }

  if (await ctx.fileExists(LEGACY_FILE)) {
    let legacy = null;
    try {
      legacy = await ctx.readJson(LEGACY_FILE);
    } catch (error) {
      ctx.warn(`Skipped ${LEGACY_FILE}: ${error.message}`);
    }
    if (Array.isArray(legacy)) {
      let changed = false;
      for (const workflow of legacy.filter(isPlainObject)) {
        const result = migrateWorkflow(workflow);
        record(workflow, result);
        changed = changed || result.changed;
      }
      if (changed) await ctx.writeJson(LEGACY_FILE, legacy);
    }
  }

  ctx.log(`Gave ${endSteps} end step(s) in ${workflows} workflow(s) an output`);
  if (asObject.length > 0) {
    ctx.log(
      `No single answer could be told for the end steps ${asObject.join(', ')}: their output is an object of the variables they pass on, as their result was before. Name the one that is the answer in the workflow editor if you want to.`
    );
  }
  if (needAdmin.length > 0) {
    ctx.warn(
      `No output could be told for the end steps ${needAdmin.join(', ')}. Set the Output of each of them in the workflow editor; until then a run that reaches one fails.`
    );
  }
}
