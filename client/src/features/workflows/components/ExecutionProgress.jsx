import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Helper to summarize a value for display
 */
const summarizeValue = (value, maxLength = 150) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value.length <= maxLength) return value;
    return value.substring(0, maxLength) + '...';
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}}`;
  }
  return String(value);
};

/**
 * Status indicator for a node
 */
function NodeStatus({ status }) {
  const config = {
    pending: { icon: 'circle', color: 'text-gray-400', bg: 'bg-gray-100' },
    running: { icon: 'arrow-path', color: 'text-blue-600', bg: 'bg-blue-100', animate: true },
    completed: { icon: 'check-circle', color: 'text-green-600', bg: 'bg-green-100' },
    failed: { icon: 'x-circle', color: 'text-red-600', bg: 'bg-red-100' },
    paused: { icon: 'pause-circle', color: 'text-yellow-600', bg: 'bg-yellow-100' }
  };

  const c = config[status] || config.pending;

  return (
    <div className={`w-8 h-8 rounded-full ${c.bg} flex items-center justify-center`}>
      <Icon name={c.icon} className={`w-5 h-5 ${c.color} ${c.animate ? 'animate-spin' : ''}`} />
    </div>
  );
}

/**
 * Expanded detail view for a single progress item
 */
function ItemDetails({ item, t }) {
  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 p-3">
      {/* Output variable and value */}
      {item.outputVariable && item.outputValue && (
        <div className="mb-3">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            {t('workflows.progress.outputVariable', 'Output Variable')}:{' '}
            <span className="font-mono text-indigo-600 dark:text-indigo-400">
              {item.outputVariable}
            </span>
          </div>
          <pre className="text-xs bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700 overflow-auto max-h-48">
            {typeof item.outputValue === 'string'
              ? item.outputValue
              : JSON.stringify(item.outputValue, null, 2)}
          </pre>
        </div>
      )}

      {/* Decision details */}
      {item.type === 'decision' && item.rawResult?.output && (
        <div className="mb-3">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            {t('workflows.progress.decisionResult', 'Decision Result')}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-1 rounded text-xs font-medium ${
                item.rawResult.output.branch === 'true'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
                  : 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300'
              }`}
            >
              Branch: {item.rawResult.output.branch}
            </span>
            {item.rawResult.output.expression && (
              <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                {item.rawResult.output.expression}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Human response details */}
      {item.type === 'human' && item.rawResult && (
        <div className="mb-3">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            {t('workflows.progress.humanResponse', 'Human Response')}
          </div>
          <div className="text-sm">
            <span className="font-medium">Choice:</span>{' '}
            {item.rawResult.output?.branch || item.rawResult.branch || item.rawResult.response}
            {(item.rawResult.output?.data?.feedback || item.rawResult.data?.feedback) && (
              <div className="mt-1 text-gray-600 dark:text-gray-400">
                <span className="font-medium">Feedback:</span>{' '}
                {item.rawResult.output?.data?.feedback || item.rawResult.data?.feedback}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Raw result for debugging (only show if no specific view) */}
      {item.rawResult &&
        !item.outputVariable &&
        item.type !== 'decision' &&
        item.type !== 'human' && (
          <div>
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {t('workflows.progress.rawOutput', 'Output')}
            </div>
            <pre className="text-xs bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700 overflow-auto max-h-32">
              {JSON.stringify(item.rawResult.output, null, 2)}
            </pre>
          </div>
        )}
    </div>
  );
}

/**
 * Component for displaying workflow execution progress.
 *
 * @param {Object} props - Component props
 * @param {Object} props.state - Execution state
 * @param {Array} [props.nodes] - Workflow node definitions (optional for displaying names)
 */
function ExecutionProgress({ state, nodes = [] }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [expandedNodes, setExpandedNodes] = useState(new Set());

  const toggleNode = nodeId => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  // Build a map of node ID to display info
  const nodeMap = useMemo(() => {
    const map = new Map();
    nodes.forEach(node => {
      const name =
        typeof node.name === 'object'
          ? node.name[currentLanguage] || node.name.en || node.id
          : node.name || node.id;
      map.set(node.id, { name, type: node.type });
    });
    return map;
  }, [nodes, currentLanguage]);

  // Calculate node statuses
  const nodeStatuses = useMemo(() => {
    const statuses = new Map();

    // Mark completed nodes
    (state?.completedNodes || []).forEach(nodeId => {
      statuses.set(nodeId, 'completed');
    });

    // Mark failed nodes
    (state?.failedNodes || []).forEach(nodeId => {
      statuses.set(nodeId, 'failed');
    });

    // Mark current nodes
    (state?.currentNodes || []).forEach(nodeId => {
      if (!statuses.has(nodeId)) {
        statuses.set(nodeId, state?.status === 'paused' ? 'paused' : 'running');
      }
    });

    return statuses;
  }, [state]);

  // Build a map of node results from state data for model info
  const nodeResults = useMemo(() => {
    return state?.data?.nodeResults || {};
  }, [state?.data?.nodeResults]);

  // Build display list from history with detailed insights
  // Show all executions (including loop iterations) for complete visibility
  // Deduplicate by keeping only the last entry for each (nodeId, iteration) pair
  const progressItems = useMemo(() => {
    const items = [];
    const seenCurrentNodes = new Set(); // Only deduplicate current nodes

    // First, collect all history entries and deduplicate
    // Keep only the last entry for each (nodeId, iteration) combination
    // This handles both node_start/node_complete pairs and SSE updates
    const historyByKey = new Map();
    const nodeOccurrences = new Map(); // Track how many times each node appears

    (state?.history || []).forEach((entry, idx) => {
      if (entry.nodeId) {
        // Use iteration from entry.data or entry itself if available, otherwise derive from occurrence count
        const iteration = entry.iteration || entry.data?.iteration;
        const actualIteration =
          iteration !== undefined ? iteration : (nodeOccurrences.get(entry.nodeId) || 0) + 1;

        // Track occurrences for deriving iteration when not provided
        if (iteration === undefined) {
          nodeOccurrences.set(entry.nodeId, actualIteration);
        }

        const key = `${entry.nodeId}-${actualIteration}`;
        // Later entries override earlier ones (node_complete comes after node_start)
        historyByKey.set(key, { entry, idx, iteration: actualIteration });
      }
    });

    // Count total occurrences per node to determine if iteration badges should show
    const nodeTotalOccurrences = new Map();
    historyByKey.forEach(({ entry }) => {
      const count = nodeTotalOccurrences.get(entry.nodeId) || 0;
      nodeTotalOccurrences.set(entry.nodeId, count + 1);
    });

    // Process deduplicated history entries in order
    const sortedEntries = Array.from(historyByKey.values()).sort((a, b) => a.idx - b.idx);
    sortedEntries.forEach(({ entry, idx, iteration }) => {
      const nodeInfo = nodeMap.get(entry.nodeId) || { name: entry.nodeId, type: 'unknown' };
      // Try iteration-specific result first, then fall back to base result
      const iterationKey = `${entry.nodeId}_iter${iteration}`;
      const result = nodeResults[iterationKey] || nodeResults[entry.nodeId];

      // Build insight summary based on node type
      let insight = null;
      let outputVariable = null;
      let outputValue = null;

      if (result) {
        // For decision nodes, show the branch taken
        if (nodeInfo.type === 'decision') {
          const branch = result.output?.branch;
          insight = branch ? `Decision: took "${branch}" branch` : 'Decision evaluated';
        }
        // For agent nodes, show what variable was set
        else if (nodeInfo.type === 'agent') {
          outputVariable = result.outputVariable;
          outputValue = result.output;
          if (outputVariable) {
            insight = `Set "${outputVariable}"`;
          }
        }
        // For human nodes, show the response
        // Handle both old format (result.response) and new format (result.output.branch)
        else if (nodeInfo.type === 'human') {
          const branch = result.output?.branch || result.branch || result.response;
          const feedback = result.output?.data?.feedback || result.data?.feedback;
          insight = branch
            ? `User chose: "${branch}"${feedback ? ` - "${summarizeValue(feedback, 50)}"` : ''}`
            : 'Awaiting user input';
        }
        // For start nodes
        else if (nodeInfo.type === 'start') {
          insight = 'Workflow started with input variables';
        }
        // For end nodes
        else if (nodeInfo.type === 'end') {
          insight = 'Workflow completed';
        }
      }

      // Show iteration badge if this node appears multiple times
      const showIterationBadge = (nodeTotalOccurrences.get(entry.nodeId) || 0) > 1;

      items.push({
        nodeId: entry.nodeId,
        historyIndex: idx, // Use history index for unique key
        name: nodeInfo.name,
        type: nodeInfo.type,
        status: nodeStatuses.get(entry.nodeId) || 'completed',
        timestamp: entry.timestamp,
        iteration, // Track iteration for loop display
        showIterationBadge, // Only show badge if node appears multiple times
        // Include model info from result if available (for agent nodes)
        model: result?.output?.model || result?.model,
        modelName: result?.output?.modelName || result?.modelName,
        // Token and timing metrics
        tokens: result?.output?.tokens || result?.tokens,
        duration: result?.metrics?.duration,
        // Insight data
        insight,
        outputVariable,
        outputValue,
        rawResult: result
      });
      seenCurrentNodes.add(entry.nodeId);
    });

    // Add current nodes that aren't in history yet (for currently executing nodes)
    (state?.currentNodes || []).forEach(nodeId => {
      if (!seenCurrentNodes.has(nodeId)) {
        const nodeInfo = nodeMap.get(nodeId) || { name: nodeId, type: 'unknown' };
        items.push({
          nodeId,
          historyIndex: `current-${nodeId}`,
          name: nodeInfo.name,
          type: nodeInfo.type,
          status: nodeStatuses.get(nodeId) || 'running',
          insight: 'Currently executing...'
        });
      }
    });

    return items;
  }, [state, nodeMap, nodeStatuses, nodeResults]);

  // Get type icon
  const getTypeIcon = type => {
    switch (type) {
      case 'start':
        return 'play-circle';
      case 'end':
        return 'stop-circle';
      case 'agent':
        return 'cpu-chip';
      case 'tool':
        return 'wrench';
      case 'decision':
        return 'arrows-right-left';
      case 'human':
        return 'hand-raised';
      case 'transform':
        return 'refresh';
      default:
        return 'cube';
    }
  };

  if (!state) {
    return null;
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
      {/* Header with overall status */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('workflows.progress.title', 'Execution Progress')}
          </h3>
          {progressItems.length > 0 && (
            <button
              onClick={() => {
                const allItemKeys = progressItems
                  .filter(item => item.rawResult || item.outputValue)
                  .map(item => `${item.nodeId}-${item.historyIndex}`);
                if (expandedNodes.size === allItemKeys.length) {
                  setExpandedNodes(new Set());
                } else {
                  setExpandedNodes(new Set(allItemKeys));
                }
              }}
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300"
            >
              {expandedNodes.size > 0
                ? t('workflows.progress.collapseAll', 'Collapse All')
                : t('workflows.progress.expandAll', 'Expand All')}
            </button>
          )}
        </div>
        <span
          className={`px-3 py-1 rounded-full text-sm font-medium ${
            state.status === 'completed' || state.status === 'approved'
              ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300'
              : state.status === 'rejected'
                ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300'
                : state.status === 'failed'
                  ? 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300'
                  : state.status === 'running'
                    ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300'
                    : state.status === 'paused'
                      ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300'
                      : state.status === 'cancelled'
                        ? 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                        : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
          }`}
        >
          {state.status.charAt(0).toUpperCase() + state.status.slice(1)}
        </span>
      </div>

      {/* Progress timeline — groups repeated iterations of the same node */}
      <div className="space-y-3">
        {(() => {
          // Group items by nodeId, preserving first-occurrence order
          const groupOrder = [];
          const groupMap = new Map();
          progressItems.forEach(item => {
            if (!groupMap.has(item.nodeId)) {
              groupMap.set(item.nodeId, []);
              groupOrder.push(item.nodeId);
            }
            groupMap.get(item.nodeId).push(item);
          });

          return groupOrder.map(nodeId => {
            const items = groupMap.get(nodeId);
            const isGrouped = items.length > 1;
            const groupKey = `group-${nodeId}`;
            const isGroupExpanded = expandedNodes.has(groupKey);
            const firstItem = items[0];
            const lastItem = items[items.length - 1];

            // For groups: show a single collapsible card
            if (isGrouped) {
              return (
                <div
                  key={groupKey}
                  className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
                >
                  {/* Group header */}
                  <button
                    onClick={() => toggleNode(groupKey)}
                    className="w-full flex items-start gap-3 p-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                  >
                    <NodeStatus status={lastItem.status} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Icon
                          name={getTypeIcon(firstItem.type)}
                          className="w-4 h-4 text-gray-400"
                        />
                        <span className="font-medium text-gray-900 dark:text-white">
                          {firstItem.name}
                        </span>
                        <span className="text-xs bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300 px-2 py-0.5 rounded">
                          {items.length} {t('workflows.progress.iterations', 'iterations')}
                        </span>
                      </div>
                      {!isGroupExpanded && lastItem.insight && (
                        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                          {lastItem.insight}
                        </p>
                      )}
                    </div>
                    <Icon
                      name={isGroupExpanded ? 'chevron-up' : 'chevron-down'}
                      className="w-5 h-5 text-gray-400 flex-shrink-0"
                    />
                  </button>

                  {/* Expanded: show each iteration as a sub-row */}
                  {isGroupExpanded && (
                    <div className="border-t border-gray-200 dark:border-gray-700">
                      {items.map(item => {
                        const itemKey = `${item.nodeId}-${item.historyIndex}`;
                        const isItemExpanded = expandedNodes.has(itemKey);
                        const hasDetails = item.rawResult || item.outputValue;

                        return (
                          <div
                            key={itemKey}
                            className="border-b last:border-b-0 border-gray-100 dark:border-gray-700"
                          >
                            <button
                              onClick={() => hasDetails && toggleNode(itemKey)}
                              className={`w-full flex items-start gap-3 p-3 pl-6 text-left ${
                                hasDetails
                                  ? 'hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer'
                                  : ''
                              }`}
                              disabled={!hasDetails}
                            >
                              <NodeStatus status={item.status} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 px-2 py-0.5 rounded">
                                    #{item.iteration}
                                  </span>
                                  {item.type === 'agent' && item.model && (
                                    <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300 px-2 py-0.5 rounded">
                                      {item.model}
                                    </span>
                                  )}
                                  {item.tokens &&
                                    (item.tokens.input > 0 || item.tokens.output > 0) && (
                                      <span
                                        className="text-xs bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 px-2 py-0.5 rounded"
                                        title={`Input: ${item.tokens.input}, Output: ${item.tokens.output}`}
                                      >
                                        {(item.tokens.input + item.tokens.output).toLocaleString()}{' '}
                                        tokens
                                      </span>
                                    )}
                                  {item.duration !== undefined && item.duration !== null && (
                                    <span className="text-xs text-gray-400 dark:text-gray-500">
                                      {item.duration >= 1000
                                        ? `${(item.duration / 1000).toFixed(1)}s`
                                        : item.duration > 0
                                          ? `${item.duration}ms`
                                          : '<1ms'}
                                    </span>
                                  )}
                                  {item.timestamp && (
                                    <span className="text-xs text-gray-400 dark:text-gray-500">
                                      {new Date(item.timestamp).toLocaleTimeString(currentLanguage)}
                                    </span>
                                  )}
                                </div>
                                {item.insight && (
                                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                                    {item.insight}
                                  </p>
                                )}
                                {item.outputVariable && item.outputValue && !isItemExpanded && (
                                  <p className="text-xs text-gray-500 dark:text-gray-500 mt-1 truncate">
                                    <span className="font-mono">{item.outputVariable}</span> ={' '}
                                    {summarizeValue(item.outputValue, 80)}
                                  </p>
                                )}
                              </div>
                              {hasDetails && (
                                <Icon
                                  name={isItemExpanded ? 'chevron-up' : 'chevron-down'}
                                  className="w-5 h-5 text-gray-400 flex-shrink-0"
                                />
                              )}
                            </button>
                            {isItemExpanded && hasDetails && <ItemDetails item={item} t={t} />}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            // Single-occurrence nodes render as before
            const item = firstItem;
            const itemKey = `${item.nodeId}-${item.historyIndex}`;
            const isExpanded = expandedNodes.has(itemKey);
            const hasDetails = item.rawResult || item.outputValue;

            return (
              <div
                key={itemKey}
                className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
              >
                <button
                  onClick={() => hasDetails && toggleNode(itemKey)}
                  className={`w-full flex items-start gap-3 p-3 text-left ${
                    hasDetails ? 'hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer' : ''
                  }`}
                  disabled={!hasDetails}
                >
                  <NodeStatus status={item.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Icon name={getTypeIcon(item.type)} className="w-4 h-4 text-gray-400" />
                      <span className="font-medium text-gray-900 dark:text-white">{item.name}</span>
                      {item.type === 'agent' && item.model && (
                        <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300 px-2 py-0.5 rounded">
                          {item.model}
                        </span>
                      )}
                      {item.tokens && (item.tokens.input > 0 || item.tokens.output > 0) && (
                        <span
                          className="text-xs bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 px-2 py-0.5 rounded"
                          title={`Input: ${item.tokens.input}, Output: ${item.tokens.output}`}
                        >
                          {(item.tokens.input + item.tokens.output).toLocaleString()} tokens
                        </span>
                      )}
                      {item.duration !== undefined && item.duration !== null && (
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {item.duration >= 1000
                            ? `${(item.duration / 1000).toFixed(1)}s`
                            : item.duration > 0
                              ? `${item.duration}ms`
                              : '<1ms'}
                        </span>
                      )}
                      {item.timestamp && (
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {new Date(item.timestamp).toLocaleTimeString(currentLanguage)}
                        </span>
                      )}
                    </div>
                    {item.insight && (
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                        {item.insight}
                      </p>
                    )}
                    {item.outputVariable && item.outputValue && !isExpanded && (
                      <p className="text-xs text-gray-500 dark:text-gray-500 mt-1 truncate">
                        <span className="font-mono">{item.outputVariable}</span> ={' '}
                        {summarizeValue(item.outputValue, 80)}
                      </p>
                    )}
                  </div>
                  {hasDetails && (
                    <Icon
                      name={isExpanded ? 'chevron-up' : 'chevron-down'}
                      className="w-5 h-5 text-gray-400 flex-shrink-0"
                    />
                  )}
                </button>
                {isExpanded && hasDetails && <ItemDetails item={item} t={t} />}
              </div>
            );
          });
        })()}
      </div>

      {/* Empty state */}
      {progressItems.length === 0 && (
        <div className="text-center py-4 text-gray-500 dark:text-gray-400">
          {t('workflows.progress.noNodes', 'Waiting to start...')}
        </div>
      )}

      {/* Errors */}
      {state.errors && state.errors.length > 0 && (
        <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
          <h4 className="text-sm font-medium text-red-800 dark:text-red-300 mb-2">
            {t('workflows.progress.errors', 'Errors')}
          </h4>
          {state.errors.map((error, idx) => (
            <p key={idx} className="text-sm text-red-700 dark:text-red-400">
              {error.message || error}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export default ExecutionProgress;
