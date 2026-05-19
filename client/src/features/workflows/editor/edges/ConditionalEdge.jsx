import { getBezierPath, BaseEdge, EdgeLabelRenderer } from '@xyflow/react';

/**
 * Custom React Flow edge component for conditional workflow edges.
 * Renders a dashed line for "never" conditions and displays a label
 * showing the condition type and optional value.
 *
 * @param {object} props - React Flow edge props
 * @param {string} props.id - Edge identifier
 * @param {number} props.sourceX - Source X position
 * @param {number} props.sourceY - Source Y position
 * @param {number} props.targetX - Target X position
 * @param {number} props.targetY - Target Y position
 * @param {string} props.sourcePosition - Source handle position
 * @param {string} props.targetPosition - Target handle position
 * @param {object} props.data - Edge data with condition type and value
 * @param {object} props.style - Additional edge styles
 */
export function ConditionalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  ...props
}) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  });

  const isNever = data?.type === 'never';
  const label = data?.type && data.type !== 'always' ? data.type : null;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          strokeDasharray: isNever ? '5,5' : undefined,
          stroke: isNever ? '#9CA3AF' : '#6B7280'
        }}
        {...props}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="absolute bg-white dark:bg-gray-700 text-xs px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 pointer-events-none"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`
            }}
          >
            {label}
            {data?.value !== undefined && `: ${data.value}`}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export default ConditionalEdge;
