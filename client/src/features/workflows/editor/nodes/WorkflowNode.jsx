import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { NODE_TYPE_COLORS } from '../workflowEditorUtils.js';

// Node type icons (simple text/emoji icons)
const NODE_ICONS = {
  start: '▶',
  end: '⏹',
  agent: '🤖',
  tool: '🔧',
  decision: '◇',
  human: '👤',
  transform: '⇄',
  planner: '📋',
  verifier: '✓',
  loop: '↻',
  http: '🌐',
  code: '{}',
  parallel: '⇉',
  join: '⇒',
  memory: '🧠'
};

function WorkflowNode({ data, selected }) {
  const { nodeType, label, nodeConfig } = data;
  const color = NODE_TYPE_COLORS[nodeType] || '#6B7280';
  const icon = NODE_ICONS[nodeType] || '?';
  const isStart = nodeType === 'start';
  const isEnd = nodeType === 'end';

  // Get a brief description from config
  const description = nodeConfig?.system
    ? nodeConfig.system.slice(0, 60) + (nodeConfig.system.length > 60 ? '...' : '')
    : nodeConfig?.goal?.slice(0, 60) || nodeConfig?.code?.slice(0, 40) || '';

  return (
    <div
      className={`rounded-lg border-2 bg-white dark:bg-gray-800 shadow-sm min-w-[160px] max-w-[200px] ${
        selected ? 'border-blue-500 shadow-md' : 'border-gray-200 dark:border-gray-600'
      }`}
      style={{ borderTopColor: color, borderTopWidth: 4 }}
    >
      {/* Target handle (top) - not for start nodes */}
      {!isStart && (
        <Handle
          type="target"
          position={Position.Top}
          className="w-3 h-3 rounded-full border-2 border-white"
          style={{ background: color }}
        />
      )}

      {/* Node header */}
      <div
        className="flex items-center gap-1.5 px-3 py-2 rounded-t"
        style={{ backgroundColor: color + '20' }}
      >
        <span className="text-sm">{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color }}>
          {nodeType}
        </span>
      </div>

      {/* Node body */}
      <div className="px-3 py-2">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{label}</div>
        {description && (
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
            {description}
          </div>
        )}
      </div>

      {/* Source handle (bottom) - not for end nodes */}
      {!isEnd && (
        <Handle
          type="source"
          position={Position.Bottom}
          className="w-3 h-3 rounded-full border-2 border-white"
          style={{ background: color }}
        />
      )}
    </div>
  );
}

export default memo(WorkflowNode);
