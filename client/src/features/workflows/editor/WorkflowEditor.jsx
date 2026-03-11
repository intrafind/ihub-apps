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
  addEdge,
  useReactFlow
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { WorkflowNode } from './nodes/WorkflowNode';
import { ConditionalEdge } from './edges/ConditionalEdge';
import { NodeConfigPanel } from './panels/NodeConfigPanel';
import {
  NODE_TYPES_LIST,
  NODE_TYPE_COLORS,
  applyDagreLayout,
  createNewNode
} from './workflowEditorUtils';

/** Map of custom node types used by React Flow */
const nodeTypes = { default: WorkflowNode };

/** Map of custom edge types used by React Flow */
const edgeTypes = { conditional: ConditionalEdge };

/**
 * Sidebar palette listing all available node types grouped by category.
 * Clicking a node type adds it to the canvas center.
 *
 * @param {object} props
 * @param {function} props.onAddNode - Callback receiving the node type string
 */
function NodePalette({ onAddNode }) {
  return (
    <div className="w-48 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 overflow-y-auto">
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-3">
        Node Types
      </h3>
      {NODE_TYPES_LIST.map(group => (
        <div key={group.group} className="mb-3">
          <div className="text-xs font-medium text-gray-400 dark:text-gray-500 mb-1">
            {group.group}
          </div>
          <div className="space-y-1">
            {group.types.map(type => (
              <button
                key={type}
                onClick={() => onAddNode(type)}
                className="w-full text-left text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center gap-2 transition-colors"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: NODE_TYPE_COLORS[type] }}
                />
                {type}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Inner editor component that has access to the ReactFlow instance via useReactFlow().
 * Must be rendered inside a ReactFlowProvider.
 *
 * @param {object} props
 * @param {object[]} props.initialNodes - Initial React Flow nodes
 * @param {object[]} props.initialEdges - Initial React Flow edges
 * @param {function} props.onSave - Save callback receiving (nodes, edges)
 * @param {function} [props.onPublish] - Optional publish callback receiving (nodes, edges)
 */
function WorkflowEditorInner({ initialNodes, initialEdges, onSave, onPublish }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNode, setSelectedNode] = useState(null);
  const reactFlowInstance = useReactFlow();

  /** Handle new edge connections between nodes */
  const onConnect = useCallback(
    params => {
      setEdges(eds =>
        addEdge({ ...params, id: `edge-${Date.now()}`, data: { type: 'always' } }, eds)
      );
    },
    [setEdges]
  );

  /** Select a node when clicked to show config panel */
  const onNodeClick = useCallback((_event, node) => {
    setSelectedNode(node);
  }, []);

  /** Deselect node when clicking empty canvas */
  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  /** Add a new node of the given type to the center of the current viewport */
  const handleAddNode = useCallback(
    type => {
      const position = reactFlowInstance.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2
      });
      const newNode = createNewNode(type, position);
      setNodes(nds => [...nds, newNode]);
    },
    [reactFlowInstance, setNodes]
  );

  /** Apply automatic dagre layout and fit the view */
  const handleAutoLayout = useCallback(() => {
    const layouted = applyDagreLayout(nodes, edges);
    setNodes(layouted);
    setTimeout(() => reactFlowInstance.fitView({ padding: 0.2 }), 50);
  }, [nodes, edges, setNodes, reactFlowInstance]);

  /** Update a specific node's data (name and/or config) */
  const handleUpdateNode = useCallback(
    (nodeId, updates) => {
      setNodes(nds =>
        nds.map(n => {
          if (n.id === nodeId) {
            return {
              ...n,
              data: { ...n.data, ...updates }
            };
          }
          return n;
        })
      );
      setSelectedNode(prev => {
        if (prev?.id === nodeId) {
          return { ...prev, data: { ...prev.data, ...updates } };
        }
        return prev;
      });
    },
    [setNodes]
  );

  return (
    <div className="flex h-full">
      <NodePalette onAddNode={handleAddNode} />

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
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background />
          <Controls />
          <MiniMap
            nodeColor={node => NODE_TYPE_COLORS[node.data?.nodeType] || '#6B7280'}
            maskColor="rgba(0,0,0,0.1)"
          />
          <Panel position="top-right" className="flex gap-2">
            <button
              onClick={handleAutoLayout}
              className="bg-gray-600 text-white text-xs px-3 py-1.5 rounded hover:bg-gray-700 transition-colors"
            >
              Auto Layout
            </button>
            {onPublish && (
              <button
                onClick={() => onPublish(nodes, edges)}
                className="bg-green-600 text-white text-xs px-3 py-1.5 rounded hover:bg-green-700 transition-colors"
              >
                Publish
              </button>
            )}
            <button
              onClick={() => onSave(nodes, edges)}
              className="bg-blue-600 text-white text-xs px-3 py-1.5 rounded hover:bg-blue-700 transition-colors"
            >
              Save
            </button>
          </Panel>
        </ReactFlow>
      </div>

      {selectedNode && (
        <NodeConfigPanel
          selectedNode={selectedNode}
          onUpdateNode={handleUpdateNode}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}

/**
 * Visual workflow editor built on React Flow.
 * Provides a drag-and-drop canvas with a node palette, auto-layout,
 * node configuration panel, and save/publish actions.
 *
 * @param {object} props
 * @param {object[]} props.initialNodes - Initial React Flow nodes
 * @param {object[]} props.initialEdges - Initial React Flow edges
 * @param {function} props.onSave - Save callback receiving (nodes, edges)
 * @param {function} [props.onPublish] - Optional publish callback receiving (nodes, edges)
 */
export function WorkflowEditor({ initialNodes, initialEdges, onSave, onPublish }) {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner
        initialNodes={initialNodes}
        initialEdges={initialEdges}
        onSave={onSave}
        onPublish={onPublish}
      />
    </ReactFlowProvider>
  );
}

export default WorkflowEditor;
