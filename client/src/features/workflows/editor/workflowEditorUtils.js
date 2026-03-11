import dagre from '@dagrejs/dagre';

// Node type color mapping
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

export const NODE_TYPES_LIST = Object.keys(NODE_TYPE_COLORS);

// Convert iHub workflow JSON to ReactFlow nodes + edges
export function workflowToFlow(workflow) {
  const nodes = workflow.nodes.map(node => ({
    id: node.id,
    type: 'workflowNode', // all use our custom WorkflowNode component
    position: node.position || { x: 0, y: 0 },
    data: {
      nodeType: node.type,
      label: node.name?.en || node.id,
      nodeConfig: node.config || {},
      nodeName: node.name,
      description: node.description
    }
  }));

  const edges = workflow.edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: 'conditionalEdge',
    data: {
      condition: edge.condition,
      label: edge.label?.en || ''
    },
    label: edge.label?.en || ''
  }));

  return { nodes, edges };
}

// Convert ReactFlow nodes + edges back to iHub workflow JSON
export function flowToWorkflow(rfNodes, rfEdges, existingWorkflow) {
  const nodes = rfNodes.map(rfNode => ({
    id: rfNode.id,
    type: rfNode.data.nodeType,
    name: rfNode.data.nodeName || { en: rfNode.data.label || rfNode.id },
    description: rfNode.data.description,
    position: rfNode.position,
    config: rfNode.data.nodeConfig || {}
  }));

  const edges = rfEdges.map(rfEdge => ({
    id: rfEdge.id,
    source: rfEdge.source,
    target: rfEdge.target,
    sourceHandle: rfEdge.sourceHandle,
    targetHandle: rfEdge.targetHandle,
    condition: rfEdge.data?.condition,
    label: rfEdge.data?.label ? { en: rfEdge.data.label } : undefined
  }));

  return {
    ...existingWorkflow,
    nodes,
    edges
  };
}

// Apply dagre auto-layout
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
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - 100, y: pos.y - 40 }
    };
  });
}

// Create a new node with defaults
export function createNewNode(type, position) {
  const id = `${type}-${Date.now()}`;
  return {
    id,
    type: 'workflowNode',
    position,
    data: {
      nodeType: type,
      label: type.charAt(0).toUpperCase() + type.slice(1),
      nodeConfig: {},
      nodeName: { en: type.charAt(0).toUpperCase() + type.slice(1) }
    }
  };
}
