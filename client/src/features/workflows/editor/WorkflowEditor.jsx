import { useState, useCallback } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import WorkflowNode from './nodes/WorkflowNode.jsx';
import ConditionalEdge from './edges/ConditionalEdge.jsx';
import NodeConfigPanel from './panels/NodeConfigPanel.jsx';
import {
  NODE_TYPE_COLORS,
  applyDagreLayout,
  createNewNode,
  workflowToFlow
} from './workflowEditorUtils.js';

const nodeTypes = { workflowNode: WorkflowNode };
const edgeTypes = { conditionalEdge: ConditionalEdge };

// Left palette with all node types
function NodePalette({ onAddNode }) {
  const nodeGroups = [
    { label: 'Flow', types: ['start', 'end'] },
    { label: 'AI', types: ['agent', 'planner', 'verifier'] },
    { label: 'Logic', types: ['decision', 'loop', 'parallel', 'join', 'transform'] },
    { label: 'Integration', types: ['tool', 'http', 'code', 'human', 'memory'] }
  ];

  return (
    <div className="w-48 border-r border-gray-200 dark:border-gray-700 overflow-y-auto bg-white dark:bg-gray-900 flex-shrink-0">
      <div className="p-2 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Nodes</h3>
      </div>
      {nodeGroups.map(group => (
        <div key={group.label} className="p-2">
          <div className="text-xs text-gray-400 mb-1 font-medium">{group.label}</div>
          {group.types.map(type => (
            <button
              key={type}
              onClick={() => onAddNode(type)}
              className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-gray-50 dark:hover:bg-gray-800 mb-0.5 transition-colors"
            >
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: NODE_TYPE_COLORS[type] }}
              />
              <span className="capitalize text-gray-700 dark:text-gray-300">{type}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function WorkflowEditorInner({ workflow, onSave, onPublish, isSaving }) {
  const { fitView, screenToFlowPosition } = useReactFlow();

  // Initialize from workflow or empty
  const initialFlow = workflow ? workflowToFlow(workflow) : { nodes: [], edges: [] };
  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlow.edges);
  const [selectedNode, setSelectedNode] = useState(null);

  const onConnect = useCallback(
    connection =>
      setEdges(eds => addEdge({ ...connection, type: 'conditionalEdge', data: {} }, eds)),
    [setEdges]
  );

  const onNodeClick = useCallback((_, node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const handleAddNode = useCallback(
    type => {
      const position = screenToFlowPosition({ x: 300, y: 200 });
      const newNode = createNewNode(type, position);
      setNodes(nds => [...nds, newNode]);
      setSelectedNode(newNode);
    },
    [screenToFlowPosition, setNodes]
  );

  const handleAutoLayout = useCallback(() => {
    setNodes(nds => applyDagreLayout(nds, edges));
    setTimeout(() => fitView({ padding: 0.2 }), 100);
  }, [edges, setNodes, fitView]);

  const handleNodeUpdate = useCallback(
    (nodeId, newData) => {
      setNodes(nds => nds.map(n => (n.id === nodeId ? { ...n, data: newData } : n)));
      // Update selected node reference
      setSelectedNode(prev => (prev?.id === nodeId ? { ...prev, data: newData } : prev));
    },
    [setNodes]
  );

  const handleSave = useCallback(() => {
    onSave(nodes, edges);
  }, [nodes, edges, onSave]);

  return (
    <div className="flex h-full w-full">
      {/* Left palette */}
      <NodePalette onAddNode={handleAddNode} />

      {/* Canvas */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          defaultEdgeOptions={{ type: 'conditionalEdge', data: {} }}
        >
          <Background variant="dots" gap={16} size={1} />
          <Controls />
          <MiniMap
            nodeColor={node => NODE_TYPE_COLORS[node.data?.nodeType] || '#6B7280'}
            className="!bg-white dark:!bg-gray-800"
          />
          <Panel position="top-right" className="flex gap-2">
            <button
              onClick={handleAutoLayout}
              className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-xs px-3 py-1.5 rounded shadow-sm hover:bg-gray-50 transition-colors"
            >
              Auto Layout
            </button>
            {onPublish && (
              <button
                onClick={onPublish}
                className="bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1.5 rounded shadow-sm transition-colors"
              >
                Publish
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded shadow-sm transition-colors"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </Panel>
        </ReactFlow>
      </div>

      {/* Right config panel */}
      <NodeConfigPanel
        node={selectedNode}
        onUpdate={handleNodeUpdate}
        onClose={() => setSelectedNode(null)}
      />
    </div>
  );
}

export default function WorkflowEditor(props) {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}
