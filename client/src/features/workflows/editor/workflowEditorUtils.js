import dagre from '@dagrejs/dagre';

/**
 * Color mapping for each workflow node type.
 * Used consistently across the visual editor for node headers, minimap, and palette indicators.
 */
export const NODE_TYPE_COLORS = {
  start: '#10B981',
  end: '#6B7280',
  prompt: '#3B82F6',
  tool: '#8B5CF6',
  decision: '#F59E0B',
  human: '#EC4899',
  transform: '#06B6D4',
  planner: '#7C3AED',
  verifier: '#059669',
  loop: '#F97316',
  http: '#0EA5E9',
  code: '#84CC16',
  parallel: '#6366F1',
  join: '#6366F1',
  memory: '#A855F7',
  'query-plan': '#2563EB',
  'corpus-search': '#0D9488',
  'structured-record': '#B45309',
  'quote-validator': '#15803D',
  'template-render': '#4F46E5',
  progress: '#64748B',
  'inbox-load': '#92400E',
  'inbox-finalize': '#92400E',
  'memory-finalize': '#7E22CE'
};

/**
 * Human-friendly metadata for every workflow node type: a short label and a
 * one-line plain-language description shown in the palette and config panel.
 * Grouping mirrors how authors think about a flow, not the executor layout.
 */
export const NODE_TYPE_META = {
  start: {
    label: 'Start',
    description: 'Where the workflow begins. Defines the inputs users provide.'
  },
  end: { label: 'End', description: 'Where the workflow finishes and returns its outputs.' },
  prompt: {
    label: 'AI Step',
    description: 'Ask an AI model to write, analyze, or transform something.'
  },
  planner: {
    label: 'Planner',
    description: 'Let an AI model break a goal into tasks that run as sub-steps.'
  },
  verifier: {
    label: 'Reviewer',
    description: 'Have an AI model check earlier results and demand improvements.'
  },
  decision: {
    label: 'Decision',
    description: 'Branch the flow depending on a condition.'
  },
  loop: {
    label: 'Repeat',
    description:
      'Repeat the steps placed inside this container — once per list item, a fixed number of times, or while a condition holds.'
  },
  parallel: {
    label: 'Parallel',
    description: 'Fork into branches that run side by side.'
  },
  join: { label: 'Join', description: 'Wait for parallel branches to finish.' },
  transform: {
    label: 'Transform',
    description: 'Reshape data: set values, pick items, count, or increment.'
  },
  code: { label: 'Code', description: 'Run a small JavaScript snippet (advanced).' },
  tool: { label: 'Tool', description: 'Call one of the configured tools (search, iFinder, …).' },
  http: { label: 'HTTP Request', description: 'Call an external API over HTTP.' },
  human: {
    label: 'Ask a Person',
    description: 'Pause and wait for a person to review, choose, or approve.'
  },
  memory: {
    label: 'Agent memory',
    description: "Read a section of an agent's long-term memory into a variable."
  },
  'query-plan': {
    label: 'Query Plan',
    description: 'Turn a question into a set of search queries.'
  },
  'corpus-search': {
    label: 'Knowledge Search',
    description: 'Search the connected knowledge corpus (iFinder) and collect documents.'
  },
  'structured-record': {
    label: 'Collect Records',
    description: 'Extract structured entries from text and accumulate them.'
  },
  'quote-validator': {
    label: 'Quote Check',
    description: 'Verify that quotes really appear in the source documents.'
  },
  'template-render': {
    label: 'Report Template',
    description: 'Render collected data into a formatted document.'
  },
  progress: {
    label: 'Progress Note',
    description: 'Show a status message to the user while the workflow runs.'
  },
  'inbox-load': {
    label: 'Inbox Load',
    description: 'Agent runtime: load the next inbox item (advanced).'
  },
  'inbox-finalize': {
    label: 'Inbox Finalize',
    description: 'Agent runtime: mark the inbox item done (advanced).'
  },
  'memory-finalize': {
    label: 'Memory Finalize',
    description: 'Agent runtime: persist composed memory (advanced).'
  }
};

/**
 * Grouped list of available node types for the palette sidebar.
 * Each group has a display label and an array of node type identifiers.
 */
export const NODE_TYPES_LIST = [
  { group: 'flow', label: 'Flow', types: ['start', 'end', 'decision', 'loop', 'parallel', 'join'] },
  { group: 'ai', label: 'AI', types: ['prompt', 'planner', 'verifier'] },
  {
    group: 'knowledge',
    label: 'Knowledge',
    types: ['query-plan', 'corpus-search', 'structured-record', 'quote-validator']
  },
  { group: 'data', label: 'Data', types: ['transform', 'code', 'template-render'] },
  { group: 'integration', label: 'Integration', types: ['tool', 'http'] },
  { group: 'people', label: 'People', types: ['human', 'progress'] },
  {
    group: 'agentRuntime',
    label: 'Agent runtime',
    types: ['memory', 'inbox-load', 'inbox-finalize', 'memory-finalize']
  }
];

/** Default canvas size for a freshly created loop container. */
export const LOOP_CONTAINER_DEFAULT_SIZE = { width: 520, height: 300 };

/**
 * Sensible starting configuration per node type so a freshly dropped node is
 * runnable (or at least self-explanatory) without opening the JSON tab.
 */
export function defaultConfigForType(type) {
  switch (type) {
    case 'loop':
      return { mode: 'forEach', array: '', outputVariable: 'results', maxIterations: 50 };
    case 'decision':
      return { type: 'expression', expression: '' };
    case 'prompt':
      return { outputVariable: '' };
    case 'progress':
      return { message: '' };
    case 'http':
      return { method: 'GET', url: '' };
    case 'human':
      return { message: { en: '' }, options: [] };
    default:
      return {};
  }
}

/**
 * Reads the rendered dimensions of a React Flow node, falling back through
 * the v12 dimension sources (explicit width/height, style, measured).
 */
function nodeDimensions(rfNode) {
  const width =
    rfNode.width ??
    rfNode.style?.width ??
    rfNode.measured?.width ??
    LOOP_CONTAINER_DEFAULT_SIZE.width;
  const height =
    rfNode.height ??
    rfNode.style?.height ??
    rfNode.measured?.height ??
    LOOP_CONTAINER_DEFAULT_SIZE.height;
  return { width: Math.round(Number(width)), height: Math.round(Number(height)) };
}

/**
 * Orders nodes so parents come before their children — React Flow requires
 * parent nodes to appear in the array before nodes that reference them.
 */
export function parentsFirst(nodes) {
  const containers = nodes.filter(n => !n.parentId);
  const children = nodes.filter(n => n.parentId);
  return [...containers, ...children];
}

/**
 * Converts a server-side workflow definition into React Flow nodes and edges.
 *
 * Loop nodes render as `loopContainer` group nodes; their body nodes carry
 * `parentId` and a position relative to the container (React Flow convention,
 * matching how the definition is persisted).
 *
 * @param {object} workflow - The workflow object from the API (with nodes[] and edges[])
 * @returns {{ nodes: object[], edges: object[] }} React Flow compatible nodes and edges
 */
export function workflowToFlow(workflow) {
  if (!workflow) return { nodes: [], edges: [] };

  const nodes = (workflow.nodes || []).map(node => {
    const isLoop = node.type === 'loop';
    const size = isLoop ? node.size || LOOP_CONTAINER_DEFAULT_SIZE : null;
    return {
      id: node.id,
      type: isLoop ? 'loopContainer' : 'default',
      position: node.position || { x: 0, y: 0 },
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(size ? { width: size.width, height: size.height, style: { ...size } } : {}),
      data: {
        nodeType: node.type,
        nodeConfig: node.config || {},
        nodeName:
          typeof node.name === 'object'
            ? node.name.en || Object.values(node.name)[0] || ''
            : node.name || '',
        // Preserved verbatim so saving from the canvas is lossless:
        nodeNameLocalized: typeof node.name === 'object' ? node.name : undefined,
        nodeDescription: node.description,
        nodeExecution: node.execution
      }
    };
  });

  const edges = (workflow.edges || []).map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    type: 'conditional',
    data: {
      condition: edge.condition || { type: 'always' },
      label: edge.label
    }
  }));

  const ordered = parentsFirst(nodes);

  // Auto-layout when the workflow has no saved positions (every node sits at origin).
  // Typically happens for newly-created workflows that haven't been arranged yet.
  const needsLayout =
    ordered.length > 1 && ordered.every(n => n.position.x === 0 && n.position.y === 0);
  if (needsLayout) {
    return { nodes: applyDagreLayout(ordered, edges), edges };
  }

  return { nodes: ordered, edges };
}

/**
 * Converts React Flow nodes and edges back into the server-side workflow format.
 * Preserves top-level workflow metadata (id, name, description, etc.) from the
 * existing workflow, and round-trips node descriptions, execution settings,
 * non-English names, container membership (parentId), container size, and
 * edge handles/labels/conditions without loss.
 *
 * @param {object[]} rfNodes - React Flow node objects
 * @param {object[]} rfEdges - React Flow edge objects
 * @param {object} existingWorkflow - The original workflow object to preserve metadata from
 * @returns {object} A workflow object ready for the API
 */
export function flowToWorkflow(rfNodes, rfEdges, existingWorkflow) {
  const nodes = rfNodes.map(rfNode => {
    const data = rfNode.data || {};
    const isLoop = data.nodeType === 'loop';
    const localized =
      data.nodeNameLocalized && typeof data.nodeNameLocalized === 'object'
        ? data.nodeNameLocalized
        : {};
    return {
      id: rfNode.id,
      type: data.nodeType,
      name: { ...localized, en: data.nodeName || localized.en || data.nodeType },
      ...(data.nodeDescription ? { description: data.nodeDescription } : {}),
      position: { x: Math.round(rfNode.position.x), y: Math.round(rfNode.position.y) },
      ...(rfNode.parentId ? { parentId: rfNode.parentId } : {}),
      ...(isLoop ? { size: nodeDimensions(rfNode) } : {}),
      config: data.nodeConfig || {},
      ...(data.nodeExecution ? { execution: data.nodeExecution } : {})
    };
  });

  const edges = rfEdges.map(rfEdge => {
    const condition = rfEdge.data?.condition;
    const label = rfEdge.data?.label;
    return {
      id: rfEdge.id,
      source: rfEdge.source,
      target: rfEdge.target,
      ...(rfEdge.sourceHandle ? { sourceHandle: rfEdge.sourceHandle } : {}),
      ...(rfEdge.targetHandle ? { targetHandle: rfEdge.targetHandle } : {}),
      ...(condition && condition.type && condition.type !== 'always' ? { condition } : {}),
      ...(label && typeof label === 'object' ? { label } : {})
    };
  });

  return {
    ...existingWorkflow,
    nodes,
    edges
  };
}

/** Canvas size used for an ordinary (non-container) step during layout. */
const STEP_LAYOUT_SIZE = { width: 200, height: 80 };

/** Space kept between a container's border and the steps inside it. */
const CONTAINER_PADDING = { top: 56, right: 24, bottom: 24, left: 24 };

/**
 * Runs one Dagre pass over a set of sibling nodes and returns their positions
 * relative to the bounding box of the result.
 *
 * @param {object[]} siblings - Nodes laid out together
 * @param {object[]} edges - All edges; only sibling-to-sibling ones are used
 * @param {Map<string, {width: number, height: number}>} sizes - Size per node id
 * @returns {{positions: Map<string, {x: number, y: number}>, width: number, height: number}}
 */
function layoutSiblings(siblings, edges, sizes) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 60 });

  const ids = new Set(siblings.map(n => n.id));
  // Dagre writes the computed coordinates onto the value object it is given,
  // so every node needs its own — sharing one leaves all nodes stacked at
  // whatever the last write produced.
  siblings.forEach(node => g.setNode(node.id, { ...(sizes.get(node.id) || STEP_LAYOUT_SIZE) }));
  edges.forEach(edge => {
    if (ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target) {
      g.setEdge(edge.source, edge.target);
    }
  });
  dagre.layout(g);

  // Dagre centres nodes on its own origin; shift so the top-left of the
  // laid-out block sits at (0, 0) and the caller can place it anywhere.
  const corners = siblings.map(node => {
    const pos = g.node(node.id);
    const size = sizes.get(node.id) || STEP_LAYOUT_SIZE;
    return pos
      ? { id: node.id, x: pos.x - size.width / 2, y: pos.y - size.height / 2, size }
      : { id: node.id, x: 0, y: 0, size };
  });
  const minX = Math.min(...corners.map(c => c.x), 0);
  const minY = Math.min(...corners.map(c => c.y), 0);

  const positions = new Map();
  let width = 0;
  let height = 0;
  corners.forEach(c => {
    const x = c.x - minX;
    const y = c.y - minY;
    positions.set(c.id, { x, y });
    width = Math.max(width, x + c.size.width);
    height = Math.max(height, y + c.size.height);
  });
  return { positions, width, height };
}

/**
 * Applies automatic Dagre-based layout to position nodes in a left-to-right flow.
 *
 * Loop containers are laid out from the inside out: each container's own steps
 * are arranged from the edges between them and the container is then grown to
 * fit, so a body is readable instead of keeping whatever positions its steps
 * happened to have. Nested containers are handled innermost-first, so an outer
 * container sizes around the already-sized inner one.
 *
 * @param {object[]} nodes - React Flow node array
 * @param {object[]} edges - React Flow edge array
 * @returns {object[]} New node array with updated positions and container sizes
 */
export function applyDagreLayout(nodes, edges) {
  const childrenOf = new Map();
  nodes.forEach(node => {
    if (!node.parentId) return;
    if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
    childrenOf.get(node.parentId).push(node);
  });

  const sizes = new Map();
  const positions = new Map();

  /**
   * Lays out one container's body and returns the size the container needs.
   * Recurses first so a nested container is sized before its parent places it.
   */
  const sizeOf = node => {
    if (sizes.has(node.id)) return sizes.get(node.id);
    const children = childrenOf.get(node.id) || [];
    if (node.type !== 'loopContainer') {
      sizes.set(node.id, STEP_LAYOUT_SIZE);
      return STEP_LAYOUT_SIZE;
    }
    children.forEach(sizeOf);
    let size;
    if (children.length === 0) {
      size = { ...LOOP_CONTAINER_DEFAULT_SIZE };
    } else {
      const laid = layoutSiblings(children, edges, sizes);
      children.forEach(child => {
        const p = laid.positions.get(child.id);
        positions.set(child.id, {
          x: p.x + CONTAINER_PADDING.left,
          y: p.y + CONTAINER_PADDING.top
        });
      });
      size = {
        width: Math.max(
          LOOP_CONTAINER_DEFAULT_SIZE.width,
          Math.round(laid.width + CONTAINER_PADDING.left + CONTAINER_PADDING.right)
        ),
        height: Math.max(
          160,
          Math.round(laid.height + CONTAINER_PADDING.top + CONTAINER_PADDING.bottom)
        )
      };
    }
    sizes.set(node.id, size);
    return size;
  };

  nodes.filter(n => !n.parentId).forEach(sizeOf);

  const topLevel = nodes.filter(n => !n.parentId);
  const laidTop = layoutSiblings(topLevel, edges, sizes);
  topLevel.forEach(node => positions.set(node.id, laidTop.positions.get(node.id)));

  return nodes.map(node => {
    const position = positions.get(node.id);
    const next = position ? { ...node, position } : { ...node };
    if (node.type === 'loopContainer') {
      const size = sizes.get(node.id);
      if (size) {
        next.width = size.width;
        next.height = size.height;
        next.style = { ...(node.style || {}), width: size.width, height: size.height };
      }
    }
    return next;
  });
}

/**
 * Creates a new React Flow node with a unique ID based on type and timestamp.
 * Loop nodes are created as sized containers; every type starts with a
 * sensible default configuration.
 *
 * @param {string} type - The node type (e.g. 'prompt', 'decision', 'tool')
 * @param {{ x: number, y: number }} position - The initial canvas position
 * @param {string} [parentId] - Optional loop container to create the node inside
 * @returns {object} A React Flow node object
 */
export function createNewNode(type, position, parentId) {
  const isLoop = type === 'loop';
  return {
    id: `${type}-${Date.now()}`,
    type: isLoop ? 'loopContainer' : 'default',
    position,
    ...(parentId ? { parentId } : {}),
    ...(isLoop
      ? {
          width: LOOP_CONTAINER_DEFAULT_SIZE.width,
          height: LOOP_CONTAINER_DEFAULT_SIZE.height,
          style: { ...LOOP_CONTAINER_DEFAULT_SIZE }
        }
      : {}),
    data: {
      nodeType: type,
      nodeConfig: defaultConfigForType(type),
      nodeName: ''
    }
  };
}

/** Loop-injected variables available to nodes inside a container. */
const LOOP_SCOPE_VARIABLES = [
  { value: '_loopItem', label: 'Current item (loop)' },
  { value: '_loopIndex', label: 'Current index, 0-based (loop)' },
  { value: '_loopHuman', label: 'Current index, 1-based (loop)' },
  { value: '_loopTotal', label: 'Total items (loop)' }
];

/**
 * Lists the state variables a single step defines.
 *
 * Steps write state through more than one config key — a tool writes its
 * `outputVariable`, a corpus search writes `corpusVar` and `coverageVar`, a
 * loop writes its `countInto` counter and named item, a transform writes each
 * operation target. Collecting them in one place is what lets the editor both
 * suggest real names and tell a typo from a variable it simply did not know
 * about.
 *
 * @param {object} rfNode - React Flow node
 * @returns {Array<{name: string, label: string}>} Variables this step defines
 */
export function variablesProducedBy(rfNode) {
  const cfg = rfNode?.data?.nodeConfig || {};
  const type = rfNode?.data?.nodeType;
  const name = rfNode?.data?.nodeName || NODE_TYPE_META[type]?.label || rfNode?.id;
  const out = [];
  const add = (variable, label) => {
    if (typeof variable === 'string' && variable.trim()) {
      out.push({ name: variable.trim().split('.')[0], label });
    }
  };

  add(cfg.outputVariable, `from ${name}`);

  if (type === 'start') {
    (Array.isArray(cfg.inputVariables) ? cfg.inputVariables : []).forEach(v =>
      add(v?.name, 'workflow input')
    );
    Object.keys(cfg.defaults || {}).forEach(key => add(key, 'start value'));
    // A start step may declare its inputs as a mapping instead of a list; the
    // keys are the state names the run begins with either way.
    Object.keys(cfg.inputMapping || {}).forEach(key => add(key, 'workflow input'));
  }

  if (type === 'loop') {
    add(cfg.countInto, `round count of ${name}`);
    add(cfg.itemVariable, `current item of ${name}`);
  }

  if (type === 'corpus-search') {
    add(cfg.corpusVar || '_corpus', `documents found by ${name}`);
    add(cfg.coverageVar || '_coverage', `coverage counters from ${name}`);
  }

  if (type === 'structured-record') {
    add(cfg.recordsVar || '_records', `records collected by ${name}`);
  }

  if (type === 'memory') {
    add(cfg.outputVariable, `memory section read by ${name}`);
  }

  if (type === 'query-plan') {
    add(cfg.outputVariable || '_queryPlan', `search plan from ${name}`);
  }

  if (type === 'template-render') {
    add(cfg.outputVariable, `report composed by ${name}`);
  }

  if (type === 'inbox-load') {
    add(cfg.outputVariable || 'currentInboxItem', `inbox item loaded by ${name}`);
  }

  if (type === 'human') {
    // The engine keys a checkpoint's answer by the step's own id unless the
    // step names it, which a step whose id contains a hyphen has to do.
    add(cfg.outputVariable || `humanResponse_${rfNode.id}`, `answer given at ${name}`);
  }

  if (type === 'verifier') {
    // VerifierNodeExecutor writes this fixed key rather than a configured one.
    add('verificationResult', `verdict from ${name}`);
  }

  if (type === 'transform') {
    (Array.isArray(cfg.operations) ? cfg.operations : []).forEach(op => {
      if (!op || typeof op !== 'object') return;
      add(op.to, `set by ${name}`);
      add(op.set, `set by ${name}`);
      add(op.increment, `counted by ${name}`);
    });
  }

  return out;
}

/**
 * The names the engine provides on its own inside a loop body.
 * Kept separate from step-produced names so the reference checker can explain
 * why a name is valid.
 */
export const LOOP_SCOPE_NAMES = ['_loopItem', '_loopIndex', '_loopHuman', '_loopTotal'];

/**
 * Run metadata the engine writes into state for every workflow, so a template
 * may read it without any step defining it. Mirrors
 * ENGINE_INTERNAL_STATE_KEYS in server/services/workflow/executors/LoopNodeExecutor.js.
 */
export const ENGINE_PROVIDED_NAMES = [
  { name: '_currentStep', label: 'Steps run so far (engine)' },
  { name: '_totalNodes', label: 'Total steps in the workflow (engine)' },
  { name: '_currentNodeIteration', label: "This step's iteration count (engine)" },
  { name: '_nodeIterations', label: 'Iteration count per step (engine)' },
  { name: '_totalElapsedMs', label: 'Elapsed run time in ms (engine)' },
  { name: '_humanWaitMs', label: 'Time spent waiting on a person (engine)' },
  { name: '_resumeCount', label: 'Times this run was resumed (engine)' },
  { name: '_pauseReason', label: 'Why the run last paused (engine)' },
  { name: '_pausedAt', label: 'When the run last paused (engine)' },
  { name: '_resumedAt', label: 'When the run last resumed (engine)' },
  { name: 'nodeResults', label: 'Raw result of each step (engine)' }
];

/**
 * Collects the workflow state variables visible to a given node: input
 * variables from the start node, `outputVariable`s of upstream nodes
 * (following edges backwards), and — for nodes inside a loop container —
 * the loop scope variables plus everything visible to the container itself.
 *
 * @param {object[]} rfNodes - React Flow nodes
 * @param {object[]} rfEdges - React Flow edges
 * @param {string} nodeId - The node whose visible variables to collect
 * @returns {Array<{value: string, label: string}>} Suggestion list for form fields
 */
export function collectUpstreamVariables(rfNodes, rfEdges, nodeId) {
  const byId = new Map(rfNodes.map(n => [n.id, n]));
  const incoming = new Map();
  rfEdges.forEach(edge => {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge.source);
  });

  const suggestions = new Map();
  const addVariable = (name, label) => {
    if (name && !suggestions.has(name)) suggestions.set(name, { value: name, label });
  };

  const visited = new Set();
  const visit = id => {
    if (!id || visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (!node) return;

    // A step never suggests what it writes itself — that is the field the
    // author is filling in, not something they can read here.
    if (id !== nodeId) {
      variablesProducedBy(node).forEach(v => addVariable(v.name, v.label));
    }

    (incoming.get(id) || []).forEach(visit);
    // A container child also sees everything the container sees.
    if (node.parentId) visit(node.parentId);
  };

  visit(nodeId);

  const startNode = rfNodes.find(n => n.data?.nodeType === 'start');
  if (startNode) visit(startNode.id);

  const self = byId.get(nodeId);
  if (self?.parentId) {
    LOOP_SCOPE_VARIABLES.forEach(v => addVariable(v.value, v.label));
    // Every enclosing loop that names its item or counts rounds contributes
    // those names too, so a step nested two containers deep can reach both.
    let container = byId.get(self.parentId);
    while (container) {
      variablesProducedBy(container).forEach(v => addVariable(v.name, v.label));
      container = container.parentId ? byId.get(container.parentId) : null;
    }
  }

  return Array.from(suggestions.values());
}

/** Matches `{{name}}` / `{{name.path}}` template references. */
const TEMPLATE_REF_RE = /\{\{\s*([A-Za-z_$][\w$]*)/g;
/**
 * Matches the argument of a block helper — the `docs` in `{{#each docs}}`.
 * Unlike names in the block body, the argument resolves against workflow
 * state, so it is checkable even when the body is not.
 */
const BLOCK_ARG_RE = /\{\{#\s*(?:if|unless|each|with)\s+([A-Za-z_$][\w$]*)/g;
/** Matches `$.data.name` state references. */
const STATE_REF_RE = /\$\.data\.([A-Za-z_$][\w$]*)/g;

/**
 * Handlebars-ish names that resolve inside a block rather than against
 * workflow state, plus the engine's own run metadata. Flagging these would be
 * noise, not help.
 */
const NON_STATE_NAMES = new Set([
  'this',
  'each',
  'if',
  'unless',
  'with',
  'else',
  'data',
  'result',
  'chatId',
  'userId',
  'workflowId'
]);

/**
 * Steps whose `{{...}}` templates resolve against a scope the step builds,
 * not against workflow state. The value lists the names that scope provides;
 * anything else in such a template still resolves through `data.`.
 */
const NODE_TEMPLATE_SCOPES = {
  // TemplateRenderNodeExecutor.composeReport
  'template-render': [
    'records',
    'coverage',
    'synthesis',
    'runId',
    'workflowId',
    'generatedAt',
    'data'
  ],
  // PromptNodeExecutor substitutes the loaded source content for these.
  prompt: ['sources', 'source'],
  planner: ['sources', 'source'],
  verifier: ['sources', 'source']
};

/** Walks every string in a config value. */
function forEachString(value, fn) {
  if (typeof value === 'string') fn(value);
  else if (Array.isArray(value)) value.forEach(v => forEachString(v, fn));
  else if (value && typeof value === 'object')
    Object.values(value).forEach(v => forEachString(v, fn));
}

/**
 * Finds `{{name}}` and `$.data.name` references that no step in the workflow
 * defines — the typos and renames that otherwise fail silently at run time,
 * rendering as an empty string in a prompt.
 *
 * Only the leading segment of a path is checked: whether `_currentDoc` exists
 * is knowable from the graph, whether it has a `.displayName` is not.
 *
 * @param {object[]} rfNodes - React Flow nodes
 * @param {object[]} rfEdges - React Flow edges
 * @returns {Array<{nodeId: string, nodeName: string, name: string}>} Unknown references
 */
export function findUnknownReferences(rfNodes, rfEdges) {
  const defined = new Set([...LOOP_SCOPE_NAMES, ...ENGINE_PROVIDED_NAMES.map(v => v.name)]);
  rfNodes.forEach(node => variablesProducedBy(node).forEach(v => defined.add(v.name)));

  const problems = [];
  const seen = new Set();
  const record = (node, name) => {
    if (defined.has(name) || NON_STATE_NAMES.has(name)) return;
    const key = `${node.id}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({
      nodeId: node.id,
      nodeName: node.data?.nodeName || NODE_TYPE_META[node.data?.nodeType]?.label || node.id,
      name
    });
  };

  rfNodes.forEach(node => {
    const scope = NODE_TEMPLATE_SCOPES[node.data?.nodeType];
    forEachString(node.data?.nodeConfig || {}, text => {
      // Inside a block helper (`{{#each docs}}{{title}}{{/each}}`) names are
      // relative to the block, so checking them against workflow state would
      // report mistakes that are not there. A checker that cries wolf gets
      // ignored, so template references in such a string are left alone —
      // `$.data.` references in it are still checked.
      const hasBlockHelper = text.includes('{{#');
      if (hasBlockHelper) {
        // The block's argument still resolves against workflow state, so a
        // stale `{{#if oldFlag}}` is caught even though names in the body
        // are left alone.
        for (const m of text.matchAll(BLOCK_ARG_RE)) {
          if (scope && scope.includes(m[1])) continue;
          record(node, m[1]);
        }
      } else {
        for (const m of text.matchAll(TEMPLATE_REF_RE)) {
          if (scope && scope.includes(m[1])) continue;
          record(node, m[1]);
        }
      }
      for (const m of text.matchAll(STATE_REF_RE)) record(node, m[1]);
    });
  });

  rfEdges.forEach(edge => {
    const target = rfNodes.find(n => n.id === edge.target);
    if (!target) return;
    forEachString(edge.data?.condition || {}, text => {
      for (const m of text.matchAll(STATE_REF_RE)) record(target, m[1]);
    });
  });

  return problems;
}

/**
 * Returns the absolute canvas position of a node (children store positions
 * relative to their container).
 */
export function absolutePosition(rfNode, rfNodes) {
  if (!rfNode.parentId) return rfNode.position;
  const parent = rfNodes.find(n => n.id === rfNode.parentId);
  if (!parent) return rfNode.position;
  const parentAbs = absolutePosition(parent, rfNodes);
  return {
    x: parentAbs.x + rfNode.position.x,
    y: parentAbs.y + rfNode.position.y
  };
}

/**
 * Builds a new workflow that is valid the moment it is created: it already
 * contains the Start and End steps (connected) that the workflow schema
 * requires, plus non-empty name/description and the standard config defaults.
 *
 * Both creation paths — the admin form/JSON page and the visual editor —
 * use this so a freshly created workflow can be saved right away and then
 * opened on the canvas.
 *
 * @param {object} [overrides] - Fields to merge over the starter (e.g. { id })
 * @returns {object} A schema-valid workflow definition
 */
export function createStarterWorkflow(overrides = {}) {
  return {
    id: '',
    name: { en: 'New Workflow' },
    description: { en: 'Describe what this workflow does.' },
    version: '1.0.0',
    enabled: true,
    status: 'draft',
    config: {
      observability: 'standard',
      persistence: 'session',
      errorHandling: 'retry',
      humanInLoop: 'none',
      maxExecutionTime: 300000,
      maxNodes: 20
    },
    nodes: [
      {
        id: 'start',
        type: 'start',
        name: { en: 'Start' },
        position: { x: 100, y: 150 },
        config: {}
      },
      {
        id: 'end',
        type: 'end',
        name: { en: 'End' },
        position: { x: 460, y: 150 },
        config: {}
      }
    ],
    edges: [{ id: 'e-start-end', source: 'start', target: 'end' }],
    ...overrides
  };
}
