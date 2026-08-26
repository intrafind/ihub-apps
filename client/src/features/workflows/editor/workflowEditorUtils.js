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
  memory: { label: 'Memory', description: 'Read or write persistent memory.' },
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

/**
 * Applies automatic Dagre-based layout to position nodes in a left-to-right flow.
 * Container children keep their relative positions — only top-level nodes are
 * re-arranged, with containers sized by their persisted dimensions.
 *
 * @param {object[]} nodes - React Flow node array
 * @param {object[]} edges - React Flow edge array
 * @returns {object[]} New node array with updated positions
 */
export function applyDagreLayout(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 60 });

  const topLevel = nodes.filter(n => !n.parentId);
  const topLevelIds = new Set(topLevel.map(n => n.id));

  topLevel.forEach(node => {
    const isContainer = node.type === 'loopContainer';
    const dims = isContainer ? nodeDimensions(node) : { width: 200, height: 80 };
    g.setNode(node.id, dims);
  });

  edges.forEach(edge => {
    if (topLevelIds.has(edge.source) && topLevelIds.has(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  });

  dagre.layout(g);

  return nodes.map(node => {
    if (node.parentId) return node;
    const nodeWithPosition = g.node(node.id);
    if (!nodeWithPosition) return node;
    const isContainer = node.type === 'loopContainer';
    const dims = isContainer ? nodeDimensions(node) : { width: 200, height: 80 };
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - dims.width / 2,
        y: nodeWithPosition.y - dims.height / 2
      }
    };
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

    const cfg = node.data?.nodeConfig || {};
    const displayName = node.data?.nodeName || NODE_TYPE_META[node.data?.nodeType]?.label || id;
    if (id !== nodeId) {
      if (typeof cfg.outputVariable === 'string' && cfg.outputVariable) {
        addVariable(cfg.outputVariable, `from ${displayName}`);
      }
      if (node.data?.nodeType === 'start' && Array.isArray(cfg.inputVariables)) {
        cfg.inputVariables.forEach(v => {
          if (v?.name) addVariable(v.name, 'workflow input');
        });
      }
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
    // Every enclosing loop that names its item contributes that name too, so a
    // step nested two containers deep can reach both items by name.
    let container = byId.get(self.parentId);
    while (container) {
      const named = container.data?.nodeConfig?.itemVariable;
      if (named) {
        addVariable(named, `current item of ${container.data?.nodeName || container.id}`);
      }
      container = container.parentId ? byId.get(container.parentId) : null;
    }
  }

  return Array.from(suggestions.values());
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
