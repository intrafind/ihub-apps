import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';

/**
 * Maps node types to their corresponding icons
 */
const NODE_TYPE_ICONS = {
  start: 'play',
  end: 'check-circle',
  agent: 'cpu-chip',
  tool: 'cog',
  decision: 'sliders',
  human: 'user',
  transform: 'refresh'
};

/**
 * Maps node types to their colors
 */
const NODE_TYPE_COLORS = {
  start:
    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-300 dark:border-green-700',
  end: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-300 dark:border-red-700',
  agent:
    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-300 dark:border-blue-700',
  tool: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-300 dark:border-orange-700',
  decision:
    'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border-purple-300 dark:border-purple-700',
  human:
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-300 dark:border-yellow-700',
  transform:
    'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400 border-cyan-300 dark:border-cyan-700'
};

/**
 * Simple workflow preview component that displays workflow structure.
 * Shows nodes in execution order with their connections.
 *
 * @param {Object} props - Component props
 * @param {Object} props.workflow - Workflow definition with nodes and edges
 */
function WorkflowPreview({ workflow }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;

  // Build ordered list of nodes based on edges
  const orderedNodes = useMemo(() => {
    if (!workflow?.nodes || !workflow?.edges) return [];

    const nodes = workflow.nodes;
    const edges = workflow.edges;

    // Find start node
    const startNode = nodes.find(n => n.type === 'start');
    if (!startNode) return nodes;

    // Build adjacency map
    const adjacency = new Map();
    edges.forEach(edge => {
      if (!adjacency.has(edge.source)) {
        adjacency.set(edge.source, []);
      }
      adjacency.get(edge.source).push(edge.target);
    });

    // Traverse graph from start node (BFS)
    const ordered = [];
    const visited = new Set();
    const queue = [startNode.id];

    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = nodes.find(n => n.id === nodeId);
      if (node) {
        ordered.push(node);
      }

      // Add connected nodes to queue
      const targets = adjacency.get(nodeId) || [];
      targets.forEach(target => {
        if (!visited.has(target)) {
          queue.push(target);
        }
      });
    }

    // Add any remaining unvisited nodes
    nodes.forEach(node => {
      if (!visited.has(node.id)) {
        ordered.push(node);
      }
    });

    return ordered;
  }, [workflow]);

  // Build connection map for showing arrows
  const connections = useMemo(() => {
    if (!workflow?.edges) return new Map();
    const map = new Map();
    workflow.edges.forEach(edge => {
      if (!map.has(edge.source)) {
        map.set(edge.source, []);
      }
      map.get(edge.source).push({
        target: edge.target,
        label: edge.sourceHandle || edge.label
      });
    });
    return map;
  }, [workflow]);

  if (!workflow || orderedNodes.length === 0) {
    return null;
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-900/50">
      <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
        <Icon name="list" className="w-4 h-4" />
        {t('workflows.startModal.structure', 'Workflow Structure')}
      </h4>

      <div className="space-y-1">
        {orderedNodes.map((node, index) => {
          const name = getLocalizedContent(node.name, currentLanguage) || node.id;
          const icon = NODE_TYPE_ICONS[node.type] || 'cube';
          const colorClasses =
            NODE_TYPE_COLORS[node.type] ||
            'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-300 dark:border-gray-600';
          const nodeConnections = connections.get(node.id) || [];
          const isLast = index === orderedNodes.length - 1;

          return (
            <div key={node.id} className="relative">
              {/* Node row */}
              <div className="flex items-center gap-2">
                {/* Vertical line (except for last) */}
                {!isLast && (
                  <div className="absolute left-4 top-8 w-0.5 h-4 bg-gray-300 dark:bg-gray-600" />
                )}

                {/* Node badge */}
                <div
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md border ${colorClasses} text-sm`}
                >
                  <Icon name={icon} className="w-4 h-4" />
                  <span className="font-medium">{name}</span>
                  <span className="text-xs opacity-60">({node.type})</span>
                </div>

                {/* Connection labels for decision nodes */}
                {nodeConnections.length > 1 && (
                  <div className="flex gap-1 text-xs text-gray-500 dark:text-gray-400">
                    {nodeConnections.map((conn, i) => (
                      <span key={i} className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                        {conn.label || `→ ${conn.target}`}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Arrow between nodes */}
              {!isLast && (
                <div className="flex items-center ml-3 py-0.5">
                  <Icon name="chevron-down" className="w-3 h-3 text-gray-400 dark:text-gray-500" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default WorkflowPreview;
