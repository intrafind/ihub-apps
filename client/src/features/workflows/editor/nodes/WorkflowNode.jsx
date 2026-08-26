import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { NODE_TYPE_COLORS, NODE_TYPE_META } from '../workflowEditorUtils';
import { NodeTypeIcon } from './nodeIcons';

/** Extracts a plain string from a localized object or scalar. */
function localizedText(value) {
  if (!value) return '';
  if (typeof value === 'object') return value.en || Object.values(value)[0] || '';
  return String(value);
}

/**
 * Builds a one-line plain-language summary of a node's configuration so the
 * card communicates what the node does without opening the config panel.
 */
function nodeSummary(type, cfg) {
  switch (type) {
    case 'start': {
      const count = Array.isArray(cfg.inputVariables) ? cfg.inputVariables.length : 0;
      return count > 0 ? `${count} input${count === 1 ? '' : 's'}` : '';
    }
    case 'end':
      return cfg.outputMapping ? `${Object.keys(cfg.outputMapping).length} outputs` : '';
    case 'prompt':
    case 'planner':
    case 'verifier':
      return localizedText(cfg.system) || cfg.goal || '';
    case 'decision':
      return (
        cfg.expression || (Array.isArray(cfg.conditions) ? `${cfg.conditions.length} cases` : '')
      );
    case 'loop': {
      const mode = cfg.mode || 'for';
      let what = '';
      if (mode === 'forEach')
        what = cfg.array ? `for each item in "${cfg.array}"` : 'for each item';
      else if (mode === 'for') what = `${cfg.count || 1}× repeat`;
      else if (mode === 'while') what = 'while condition holds';
      else if (mode === 'drain') what = 'work through task queue';
      return cfg.outputVariable ? `${what} → ${cfg.outputVariable}` : what;
    }
    case 'transform': {
      const count = Array.isArray(cfg.operations) ? cfg.operations.length : 0;
      return count > 0 ? `${count} operation${count === 1 ? '' : 's'}` : '';
    }
    case 'tool':
      return cfg.toolId || cfg.tool || '';
    case 'http':
      return cfg.url ? `${cfg.method || 'GET'} ${cfg.url}` : '';
    case 'code':
      return (cfg.code || '').split('\n')[0];
    case 'human':
      return localizedText(cfg.message);
    case 'progress':
      return typeof cfg.message === 'string' ? cfg.message : localizedText(cfg.message);
    case 'query-plan':
      return cfg.goal || cfg.question || '';
    case 'corpus-search':
      return cfg.searchProfile ? `profile: ${cfg.searchProfile}` : cfg.query || '';
    case 'structured-record':
      return cfg.outputVariable ? `→ ${cfg.outputVariable}` : '';
    case 'template-render':
      return (typeof cfg.template === 'string' ? cfg.template : '').split('\n')[0];
    case 'memory':
      return cfg.operation ? `${cfg.operation} ${cfg.key || ''}`.trim() : '';
    default:
      return '';
  }
}

/**
 * Custom React Flow node component for rendering workflow nodes.
 * Shows an icon + friendly type label header, the node name, and a
 * plain-language summary of its configuration. Decision nodes expose two
 * labeled source handles (true/false) so branches are visible on the canvas.
 *
 * @param {object} props - React Flow node props
 * @param {object} props.data - Node data: nodeType, nodeName, nodeConfig, nodeId, onDelete
 * @param {boolean} props.selected - Whether the node is currently selected
 */
export const WorkflowNode = memo(function WorkflowNode({ data, selected }) {
  const color = NODE_TYPE_COLORS[data.nodeType] || '#6B7280';
  const meta = NODE_TYPE_META[data.nodeType] || {};
  const isStart = data.nodeType === 'start';
  const isEnd = data.nodeType === 'end';
  const isDecision = data.nodeType === 'decision';

  let preview = nodeSummary(data.nodeType, data.nodeConfig || {});
  if (preview.length > 64) preview = preview.slice(0, 61) + '...';

  return (
    <div
      className={`group relative rounded-lg shadow-md border-2 bg-white dark:bg-gray-800 min-w-[180px] max-w-[230px] ${
        selected ? 'ring-2 ring-blue-400' : ''
      }`}
      style={{ borderColor: color }}
    >
      {!isStart && <Handle type="target" position={Position.Left} className="!bg-gray-400" />}

      <div
        className="px-3 py-1.5 text-xs font-semibold text-white rounded-t-md flex items-center gap-1.5"
        style={{ backgroundColor: color }}
        title={meta.description || ''}
      >
        <NodeTypeIcon type={data.nodeType} className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{meta.label || data.nodeType}</span>
      </div>

      {!isStart && !isEnd && data.onDelete && (
        <button
          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 bg-red-500 hover:bg-red-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs transition-opacity"
          onClick={e => {
            e.stopPropagation();
            data.onDelete(data.nodeId);
          }}
          title="Delete node"
          aria-label="Delete node"
        >
          &#x2715;
        </button>
      )}

      <div className="px-3 py-2">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {data.nodeName || meta.label || data.nodeType}
        </div>
        {preview && (
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">{preview}</div>
        )}
      </div>

      {isDecision ? (
        <>
          <Handle
            type="source"
            id="true"
            position={Position.Right}
            style={{ top: '35%' }}
            className="!bg-emerald-500"
          />
          <Handle
            type="source"
            id="false"
            position={Position.Right}
            style={{ top: '72%' }}
            className="!bg-rose-400"
          />
          <span className="absolute right-1.5 top-[35%] -translate-y-1/2 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400 pointer-events-none">
            yes
          </span>
          <span className="absolute right-1.5 top-[72%] -translate-y-1/2 text-[9px] font-semibold text-rose-500 dark:text-rose-400 pointer-events-none">
            no
          </span>
        </>
      ) : (
        !isEnd && <Handle type="source" position={Position.Right} className="!bg-gray-400" />
      )}
    </div>
  );
});

export default WorkflowNode;
