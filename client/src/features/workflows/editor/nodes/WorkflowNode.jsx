import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { NODE_TYPE_COLORS } from '../workflowEditorUtils';

/**
 * Custom React Flow node component for rendering workflow nodes.
 * Displays the node type as a colored header, the node name, and a config preview.
 * Start nodes have no target handle; end nodes have no source handle.
 *
 * @param {object} props - React Flow node props
 * @param {object} props.data - Node data containing nodeType, nodeName, and nodeConfig
 * @param {boolean} props.selected - Whether the node is currently selected
 */
export const WorkflowNode = memo(function WorkflowNode({ data, selected }) {
  const color = NODE_TYPE_COLORS[data.nodeType] || '#6B7280';
  const isStart = data.nodeType === 'start';
  const isEnd = data.nodeType === 'end';

  // Build a short preview string from the node config
  let preview = '';
  const cfg = data.nodeConfig || {};
  if (cfg.system) {
    preview = typeof cfg.system === 'object' ? cfg.system.en || '' : cfg.system || '';
  } else if (cfg.goal) {
    preview = cfg.goal;
  } else if (cfg.code) {
    preview = cfg.code;
  } else if (cfg.url) {
    preview = cfg.url;
  }

  if (preview.length > 60) preview = preview.slice(0, 57) + '...';

  return (
    <div
      className={`rounded-lg shadow-md border-2 bg-white dark:bg-gray-800 min-w-[180px] max-w-[220px] ${
        selected ? 'ring-2 ring-blue-400' : ''
      }`}
      style={{ borderColor: color }}
    >
      {!isStart && <Handle type="target" position={Position.Top} className="!bg-gray-400" />}

      <div
        className="px-3 py-1.5 text-xs font-semibold text-white rounded-t-md"
        style={{ backgroundColor: color }}
      >
        {data.nodeType}
      </div>

      <div className="px-3 py-2">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {data.nodeName || data.nodeType}
        </div>
        {preview && (
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">{preview}</div>
        )}
      </div>

      {!isEnd && <Handle type="source" position={Position.Bottom} className="!bg-gray-400" />}
    </div>
  );
});

export default WorkflowNode;
