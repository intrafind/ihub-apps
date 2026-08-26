import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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
import { LoopContainerNode } from './nodes/LoopContainerNode';
import { NodeTypeIcon } from './nodes/nodeIcons';
import { ConditionalEdge } from './edges/ConditionalEdge';
import { NodeConfigPanel } from './panels/NodeConfigPanel';
import { EdgeConfigPanel } from './panels/EdgeConfigPanel';
import {
  NODE_TYPES_LIST,
  NODE_TYPE_COLORS,
  NODE_TYPE_META,
  applyDagreLayout,
  createNewNode,
  parentsFirst,
  absolutePosition,
  collectUpstreamVariables,
  findUnknownReferences
} from './workflowEditorUtils';

/** Map of custom node types used by React Flow */
const nodeTypes = { default: WorkflowNode, loopContainer: LoopContainerNode };

/** Map of custom edge types used by React Flow */
const edgeTypes = { conditional: ConditionalEdge, default: ConditionalEdge };

/** Reads a node's rendered dimensions with sensible fallbacks. */
function dimsOf(node) {
  return {
    width: node.width ?? node.style?.width ?? node.measured?.width ?? 200,
    height: node.height ?? node.style?.height ?? node.measured?.height ?? 80
  };
}

/**
 * Sidebar palette listing all available node types grouped by category,
 * with icons, friendly names, hover descriptions, and a search filter.
 * Clicking a node type adds it to the canvas center (adopted by a loop
 * container when the center lies inside one).
 *
 * @param {object} props
 * @param {function} props.onAddNode - Callback receiving the node type string
 */
function NodePalette({ onAddNode }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NODE_TYPES_LIST;
    return NODE_TYPES_LIST.map(group => ({
      ...group,
      types: group.types.filter(type => {
        const meta = NODE_TYPE_META[type] || {};
        return (
          type.includes(q) ||
          (meta.label || '').toLowerCase().includes(q) ||
          (meta.description || '').toLowerCase().includes(q)
        );
      })
    })).filter(group => group.types.length > 0);
  }, [query]);

  return (
    <div className="w-56 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 overflow-y-auto">
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">
        {t('workflows.editor.nodeTypes', 'Add a step')}
      </h3>
      <input
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('workflows.editor.searchNodes', 'Search steps...')}
        className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 mb-3 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
        aria-label={t('workflows.editor.searchNodes', 'Search steps...')}
      />
      {groups.map(group => (
        <div key={group.group} className="mb-3">
          <div className="text-xs font-medium text-gray-400 dark:text-gray-500 mb-1">
            {t(`workflows.editor.groups.${group.group}`, group.label)}
          </div>
          <div className="space-y-1">
            {group.types.map(type => {
              const meta = NODE_TYPE_META[type] || {};
              return (
                <button
                  key={type}
                  onClick={() => onAddNode(type)}
                  title={meta.description || ''}
                  className="w-full text-left text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center gap-2 transition-colors"
                >
                  <span
                    className="w-5 h-5 rounded flex items-center justify-center text-white flex-shrink-0"
                    style={{ backgroundColor: NODE_TYPE_COLORS[type] }}
                  >
                    <NodeTypeIcon type={type} className="w-3 h-3" />
                  </span>
                  <span className="truncate">{meta.label || type}</span>
                </button>
              );
            })}
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
 * Loop nodes are containers: nodes dropped inside them become the loop body
 * (they carry parentId and relative positions). Edges may not cross a
 * container boundary; decision handles auto-set yes/no edge conditions;
 * clicking an edge opens the condition editor.
 *
 * @param {object} props
 * @param {object[]} props.initialNodes - Initial React Flow nodes
 * @param {object[]} props.initialEdges - Initial React Flow edges
 * @param {function} props.onSave - Save callback receiving (nodes, edges)
 * @param {function} [props.onPublish] - Optional publish callback receiving (nodes, edges)
 */
function WorkflowEditorInner({ initialNodes, initialEdges, onSave, onPublish }) {
  const { t } = useTranslation();
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [notice, setNotice] = useState(null);
  const reactFlowInstance = useReactFlow();

  const showNotice = useCallback(message => {
    setNotice(message);
    setTimeout(() => setNotice(null), 3500);
  }, []);

  /** Collects a node and every node nested below it. */
  const withDescendants = useCallback(
    rootId => {
      const ids = new Set([rootId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of nodes) {
          if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) {
            ids.add(n.id);
            grew = true;
          }
        }
      }
      return ids;
    },
    [nodes]
  );

  /**
   * Finds the loop container (if any) whose box contains the given absolute
   * point. A container can be nested inside another one, but never inside
   * itself or its own body — those are excluded.
   */
  const containerAt = useCallback(
    (x, y, excludeId) => {
      const excluded = excludeId ? withDescendants(excludeId) : new Set();
      for (const node of nodes) {
        if (node.type !== 'loopContainer' || excluded.has(node.id)) continue;
        const { width, height } = dimsOf(node);
        const pos = absolutePosition(node, nodes);
        if (x >= pos.x && x <= pos.x + width && y >= pos.y && y <= pos.y + height) {
          return node;
        }
      }
      return null;
    },
    [nodes, withDescendants]
  );

  /**
   * Handle new edge connections between nodes. Connections may not cross a
   * loop container boundary; decision branch handles carry their yes/no
   * condition onto the edge automatically.
   */
  const onConnect = useCallback(
    params => {
      const sourceNode = nodes.find(n => n.id === params.source);
      const targetNode = nodes.find(n => n.id === params.target);
      if ((sourceNode?.parentId || null) !== (targetNode?.parentId || null)) {
        showNotice(
          t(
            'workflows.editor.noCrossBoundaryEdges',
            'Connections cannot cross a loop boundary — connect the loop itself instead.'
          )
        );
        return;
      }
      let condition = { type: 'always' };
      if (
        sourceNode?.data?.nodeType === 'decision' &&
        (params.sourceHandle === 'true' || params.sourceHandle === 'false')
      ) {
        condition = { type: 'equals', field: 'result.branch', value: params.sourceHandle };
      }
      setEdges(eds =>
        addEdge(
          { ...params, id: `edge-${Date.now()}`, type: 'conditional', data: { condition } },
          eds
        )
      );
    },
    [nodes, setEdges, showNotice, t]
  );

  /** Select a node when clicked to show config panel */
  const onNodeClick = useCallback((_event, node) => {
    setSelectedNode(node);
    setSelectedEdge(null);
  }, []);

  /** Select an edge when clicked to show the condition editor */
  const onEdgeClick = useCallback((_event, edge) => {
    setSelectedEdge(edge);
    setSelectedNode(null);
  }, []);

  /** Deselect when clicking empty canvas */
  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
  }, []);

  /**
   * Adopt or release container membership after a drag: dropping a node
   * inside a loop box makes it part of the body; dragging it out releases
   * it. Edges that would cross the new boundary are removed (with a notice).
   */
  const onNodeDragStop = useCallback(
    (_event, dragged) => {
      if (dragged.data?.nodeType === 'start' || dragged.data?.nodeType === 'end') return;

      const node = nodes.find(n => n.id === dragged.id);
      if (!node) return;
      const moved = { ...node, position: dragged.position };
      const abs = absolutePosition(moved, nodes);
      const { width, height } = dimsOf(node);
      const target = containerAt(abs.x + width / 2, abs.y + height / 2, dragged.id);

      const currentParent = node.parentId || null;
      const nextParent = target?.id || null;
      if (currentParent === nextParent) return;

      const parentAbs = target ? absolutePosition(target, nodes) : null;
      const nextNodes = parentsFirst(
        nodes.map(n => {
          if (n.id !== dragged.id) return n;
          const updated = { ...n };
          if (nextParent) {
            updated.parentId = nextParent;
            updated.position = { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y };
          } else {
            delete updated.parentId;
            updated.position = abs;
          }
          return updated;
        })
      );
      setNodes(nextNodes);

      // Remove edges that now cross the container boundary.
      const parentOf = new Map(nextNodes.map(n => [n.id, n.parentId || null]));
      const crossing = edges.filter(
        e => (parentOf.get(e.source) ?? null) !== (parentOf.get(e.target) ?? null)
      );
      if (crossing.length > 0) {
        setEdges(eds => eds.filter(e => !crossing.includes(e)));
        showNotice(
          t(
            'workflows.editor.boundaryEdgesRemoved',
            'Connections crossing the loop boundary were removed — reconnect inside or outside the loop.'
          )
        );
      }
      showNotice(
        nextParent
          ? t('workflows.editor.nodeAdopted', 'Step added to the loop — it now runs once per item.')
          : t('workflows.editor.nodeReleased', 'Step moved out of the loop.')
      );
    },
    [nodes, edges, containerAt, setNodes, setEdges, showNotice, t]
  );

  /**
   * Add a new node of the given type at the center of the current viewport.
   * If the center lies inside a loop container, the node is created as part
   * of that loop's body.
   */
  const handleAddNode = useCallback(
    type => {
      const center = reactFlowInstance.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2
      });
      const container = containerAt(center.x, center.y, null);
      let position = center;
      if (container) {
        const parentAbs = absolutePosition(container, nodes);
        position = { x: center.x - parentAbs.x, y: center.y - parentAbs.y };
      }
      const newNode = createNewNode(type, position, container?.id);
      setNodes(nds => parentsFirst([...nds, newNode]));
      if (container) {
        showNotice(
          t('workflows.editor.nodeAdopted', 'Step added to the loop — it now runs once per item.')
        );
      }
    },
    [reactFlowInstance, containerAt, nodes, setNodes, showNotice, t]
  );

  // References to names no step defines. Surfaced continuously rather than
  // only on save, because the fix — a rename or a typo correction — is
  // cheapest while the author is still looking at the step.
  const unknownReferences = useMemo(() => findUnknownReferences(nodes, edges), [nodes, edges]);

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

  /** Update a specific edge's data (condition) */
  const handleUpdateEdge = useCallback(
    (edgeId, updates) => {
      setEdges(eds =>
        eds.map(e => (e.id === edgeId ? { ...e, data: { ...e.data, ...updates } } : e))
      );
      setSelectedEdge(prev =>
        prev?.id === edgeId ? { ...prev, data: { ...prev.data, ...updates } } : prev
      );
    },
    [setEdges]
  );

  /** Delete an edge and close the panel */
  const handleDeleteEdge = useCallback(
    edgeId => {
      setEdges(eds => eds.filter(e => e.id !== edgeId));
      setSelectedEdge(prev => (prev?.id === edgeId ? null : prev));
    },
    [setEdges]
  );

  /**
   * Delete a node and any edges connected to it. Deleting a loop container
   * also deletes its body nodes (and their edges).
   */
  const handleDeleteNode = useCallback(
    nodeId => {
      setNodes(nds => {
        const doomed = new Set([nodeId]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const n of nds) {
            if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
              doomed.add(n.id);
              grew = true;
            }
          }
        }
        setEdges(eds => eds.filter(e => !doomed.has(e.source) && !doomed.has(e.target)));
        setSelectedNode(prev => (prev && doomed.has(prev.id) ? null : prev));
        return nds.filter(n => !doomed.has(n.id));
      });
    },
    [setNodes, setEdges]
  );

  /**
   * Nodes enriched with `nodeId` + `onDelete` (so the WorkflowNode can render
   * an in-canvas delete button) and a `deletable` flag (start/end nodes are
   * never deletable).
   */
  const enrichedNodes = useMemo(
    () =>
      nodes.map(n => ({
        ...n,
        deletable: n.data.nodeType !== 'start' && n.data.nodeType !== 'end',
        data: { ...n.data, nodeId: n.id, onDelete: handleDeleteNode }
      })),
    [nodes, handleDeleteNode]
  );

  const selectedNodeVariables = useMemo(
    () => (selectedNode ? collectUpstreamVariables(nodes, edges, selectedNode.id) : []),
    [selectedNode, nodes, edges]
  );

  const selectedEdgeVariables = useMemo(
    () => (selectedEdge ? collectUpstreamVariables(nodes, edges, selectedEdge.target) : []),
    [selectedEdge, nodes, edges]
  );

  return (
    <div className="flex h-full min-h-0">
      <NodePalette onAddNode={handleAddNode} />

      <div className="flex-1 relative min-h-0">
        <ReactFlow
          nodes={enrichedNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          onNodeDragStop={onNodeDragStop}
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
          {unknownReferences.length > 0 && (
            <Panel position="top-left">
              <div className="max-w-sm bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                <p className="font-medium">
                  {t(
                    'workflows.editor.unknownVariables',
                    'These names are used but never set — they will be empty at run time:'
                  )}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {unknownReferences.slice(0, 6).map(ref => (
                    <li key={`${ref.nodeId}:${ref.name}`}>
                      <button
                        type="button"
                        onClick={() => {
                          const target = nodes.find(n => n.id === ref.nodeId);
                          if (target) setSelectedNode(target);
                        }}
                        className="font-mono hover:underline text-left"
                      >
                        {`{{${ref.name}}}`}
                      </button>
                      <span className="opacity-70">{` in ${ref.nodeName}`}</span>
                    </li>
                  ))}
                </ul>
                {unknownReferences.length > 6 && (
                  <p className="mt-1 opacity-70">
                    {t('workflows.editor.andMore', '…and {{count}} more', {
                      count: unknownReferences.length - 6
                    })}
                  </p>
                )}
              </div>
            </Panel>
          )}
          <Panel position="top-right" className="flex gap-2">
            <button
              onClick={handleAutoLayout}
              className="bg-gray-600 text-white text-xs px-3 py-1.5 rounded hover:bg-gray-700 transition-colors"
            >
              {t('workflows.editor.autoLayout', 'Auto Layout')}
            </button>
            {onPublish && (
              <button
                onClick={() => onPublish(nodes, edges)}
                className="bg-green-600 text-white text-xs px-3 py-1.5 rounded hover:bg-green-700 transition-colors"
              >
                {t('workflows.editor.publish', 'Publish')}
              </button>
            )}
            <button
              onClick={() => onSave(nodes, edges)}
              className="bg-blue-600 text-white text-xs px-3 py-1.5 rounded hover:bg-blue-700 transition-colors"
            >
              {t('workflows.editor.save', 'Save')}
            </button>
          </Panel>
          {notice && (
            <Panel position="bottom-center">
              <div className="bg-gray-800 text-white text-xs px-3 py-2 rounded shadow-lg max-w-md">
                {notice}
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>

      {selectedNode && (
        <NodeConfigPanel
          selectedNode={selectedNode}
          variables={selectedNodeVariables}
          onUpdateNode={handleUpdateNode}
          onDeleteNode={handleDeleteNode}
          onClose={() => setSelectedNode(null)}
        />
      )}
      {selectedEdge && !selectedNode && (
        <EdgeConfigPanel
          selectedEdge={selectedEdge}
          variables={selectedEdgeVariables}
          onUpdateEdge={handleUpdateEdge}
          onDeleteEdge={handleDeleteEdge}
          onClose={() => setSelectedEdge(null)}
        />
      )}
    </div>
  );
}

/**
 * Visual workflow editor built on React Flow.
 * Provides a drag-and-drop canvas with a searchable node palette, loop
 * containers (drop nodes inside to build the body), labeled decision
 * branches, an edge condition editor, auto-layout, node configuration
 * panel, and save/publish actions.
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
