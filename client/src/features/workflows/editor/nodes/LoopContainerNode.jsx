import { memo } from 'react';
import { Handle, Position, NodeResizer } from '@xyflow/react';
import { NODE_TYPE_COLORS, NODE_TYPE_META } from '../workflowEditorUtils';
import { NodeTypeIcon } from './nodeIcons';

const LOOP_COLOR = NODE_TYPE_COLORS.loop;

/** Builds the plain-language repetition summary shown in the container header. */
function repetitionSummary(cfg = {}) {
  const mode = cfg.mode || 'for';
  if (mode === 'forEach') {
    return cfg.array ? `for each item in "${cfg.array}"` : 'for each item in a list';
  }
  if (mode === 'for') return `${cfg.count || 1} times`;
  if (mode === 'while') return 'while the condition holds';
  if (mode === 'drain') return 'until the task queue is empty';
  return '';
}

/**
 * Container node for loops: a resizable box whose child nodes form the loop
 * body. The header names the loop and states what it repeats over; a hint
 * chip inside reminds authors which loop variables are available. Children
 * are ordinary workflow nodes carrying `parentId` — drop nodes into the box
 * to add them to the body.
 *
 * @param {object} props - React Flow node props
 * @param {object} props.data - Node data: nodeType, nodeName, nodeConfig, nodeId, onDelete
 * @param {boolean} props.selected - Whether the node is currently selected
 */
export const LoopContainerNode = memo(function LoopContainerNode({ data, selected }) {
  const cfg = data.nodeConfig || {};
  const meta = NODE_TYPE_META.loop;
  const summary = repetitionSummary(cfg);
  const parallel = Number(cfg.concurrency) > 1;

  return (
    <div
      className={`group relative w-full h-full rounded-xl border-2 border-dashed ${
        selected ? 'ring-2 ring-blue-400' : ''
      }`}
      style={{
        borderColor: LOOP_COLOR,
        backgroundColor: 'rgba(249, 115, 22, 0.05)'
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={320}
        minHeight={200}
        lineClassName="!border-orange-400"
        handleClassName="!bg-orange-400 !border-orange-500"
      />

      <Handle type="target" position={Position.Left} className="!bg-gray-400" />

      <div
        className="absolute -top-9 left-0 flex items-center gap-2 px-3 py-1.5 rounded-t-lg text-xs font-semibold text-white max-w-full"
        style={{ backgroundColor: LOOP_COLOR }}
        title={meta.description}
      >
        <NodeTypeIcon type="loop" className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{data.nodeName || meta.label}</span>
        {summary && <span className="font-normal opacity-90 truncate">· {summary}</span>}
        {parallel && (
          <span className="font-normal bg-white/20 rounded px-1 shrink-0">
            parallel ×{cfg.concurrency}
          </span>
        )}
      </div>

      {data.onDelete && (
        <button
          className="absolute -top-8 right-0 opacity-0 group-hover:opacity-100 bg-red-500 hover:bg-red-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs transition-opacity"
          onClick={e => {
            e.stopPropagation();
            data.onDelete(data.nodeId);
          }}
          title="Delete loop and its steps"
          aria-label="Delete loop and its steps"
        >
          &#x2715;
        </button>
      )}

      <div className="absolute top-2 left-2 flex items-center gap-1 text-[10px] font-mono text-orange-700 dark:text-orange-300 bg-white/80 dark:bg-gray-900/60 border border-orange-200 dark:border-orange-800 rounded-full px-2 py-0.5 pointer-events-none">
        <span aria-hidden="true">⟳</span>
        <span>
          each item: {'{{_loopItem}}'} · #{'{{_loopHuman}}'}/{'{{_loopTotal}}'}
        </span>
      </div>

      {cfg.outputVariable && (
        <div className="absolute bottom-2 right-2 text-[10px] font-mono text-orange-700 dark:text-orange-300 bg-white/80 dark:bg-gray-900/60 border border-orange-200 dark:border-orange-800 rounded-full px-2 py-0.5 pointer-events-none">
          collects → {cfg.outputVariable}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!bg-gray-400" />
    </div>
  );
});

export default LoopContainerNode;
