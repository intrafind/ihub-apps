import dagre from '@dagrejs/dagre';

/**
 * Color mapping for each workflow node type.
 * Used consistently across the visual editor for node headers, minimap, and palette indicators.
 */
export const NODE_TYPE_COLORS = {
  start: '#10B981',
  end: '#6B7280',
  agent: '#3B82F6',
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
  memory: '#A855F7'
};

/**
 * Grouped list of available node types for the palette sidebar.
 * Each group has a display label and an array of node type identifiers.
 */
export const NODE_TYPES_LIST = [
  { group: 'Flow', types: ['start', 'end'] },
  { group: 'AI', types: ['agent', 'planner', 'verifier'] },
  { group: 'Logic', types: ['decision', 'loop', 'parallel', 'join', 'transform', 'code'] },
  { group: 'Integration', types: ['tool', 'http', 'human', 'memory'] }
];

/**
 * Converts a server-side workflow definition into React Flow nodes and edges.
 *
 * @param {object} workflow - The workflow object from the API (with nodes[] and edges[])
 * @returns {{ nodes: object[], edges: object[] }} React Flow compatible nodes and edges
 */
export function workflowToFlow(workflow) {
  if (!workflow) return { nodes: [], edges: [] };

  const nodes = (workflow.nodes || []).map(node => ({
    id: node.id,
    type: 'default',
    position: node.position || { x: 0, y: 0 },
    data: {
      nodeType: node.type,
      nodeConfig: node.config || {},
      nodeName:
        typeof node.name === 'object'
          ? node.name.en || Object.values(node.name)[0] || ''
          : node.name || ''
    }
  }));

  const edges = (workflow.edges || []).map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.condition?.type === 'never' ? 'conditional' : 'default',
    data: edge.condition || { type: 'always' },
    label:
      edge.condition?.type && edge.condition.type !== 'always' ? edge.condition.type : undefined
  }));

  return { nodes, edges };
}

/**
 * Converts React Flow nodes and edges back into the server-side workflow format.
 * Preserves top-level workflow metadata (id, name, description, etc.) from the existing workflow.
 *
 * @param {object[]} rfNodes - React Flow node objects
 * @param {object[]} rfEdges - React Flow edge objects
 * @param {object} existingWorkflow - The original workflow object to preserve metadata from
 * @returns {object} A workflow object ready for the API
 */
export function flowToWorkflow(rfNodes, rfEdges, existingWorkflow) {
  const nodes = rfNodes.map(rfNode => ({
    id: rfNode.id,
    type: rfNode.data.nodeType,
    name: { en: rfNode.data.nodeName || rfNode.data.nodeType },
    position: { x: Math.round(rfNode.position.x), y: Math.round(rfNode.position.y) },
    config: rfNode.data.nodeConfig || {}
  }));

  const edges = rfEdges.map(rfEdge => ({
    id: rfEdge.id,
    source: rfEdge.source,
    target: rfEdge.target,
    ...(rfEdge.data && rfEdge.data.type !== 'always' ? { condition: rfEdge.data } : {})
  }));

  return {
    ...existingWorkflow,
    nodes,
    edges
  };
}

/**
 * Applies automatic Dagre-based layout to position nodes in a top-to-bottom hierarchy.
 * Useful when importing workflows that have no position data, or to tidy up a messy graph.
 *
 * @param {object[]} nodes - React Flow node array
 * @param {object[]} edges - React Flow edge array
 * @returns {object[]} New node array with updated positions
 */
export function applyDagreLayout(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 80, nodesep: 60 });

  nodes.forEach(node => {
    g.setNode(node.id, { width: 200, height: 80 });
  });

  edges.forEach(edge => {
    g.setEdge(edge.source, edge.target);
  });

  dagre.layout(g);

  return nodes.map(node => {
    const nodeWithPosition = g.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - 100,
        y: nodeWithPosition.y - 40
      }
    };
  });
}

/**
 * Creates a new React Flow node with a unique ID based on type and timestamp.
 *
 * @param {string} type - The node type (e.g. 'agent', 'decision', 'tool')
 * @param {{ x: number, y: number }} position - The initial canvas position
 * @returns {object} A React Flow node object
 */
export function createNewNode(type, position) {
  return {
    id: `${type}-${Date.now()}`,
    type: 'default',
    position,
    data: {
      nodeType: type,
      nodeConfig: {},
      nodeName: ''
    }
  };
}
