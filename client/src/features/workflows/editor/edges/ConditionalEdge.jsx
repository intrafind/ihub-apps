import { getBezierPath, BaseEdge, EdgeLabelRenderer } from '@xyflow/react';

/** Builds a short human-readable label for an edge condition. */
export function conditionLabel(condition) {
  if (!condition || !condition.type || condition.type === 'always') return null;
  switch (condition.type) {
    case 'never':
      return 'never';
    case 'equals':
      if (condition.field === 'result.branch' && condition.value === 'true') return 'yes';
      if (condition.field === 'result.branch' && condition.value === 'false') return 'no';
      return `${condition.field} = ${condition.value}`;
    case 'contains':
      return `${condition.field} contains ${condition.value}`;
    case 'exists':
      return `${condition.field} exists`;
    case 'expression': {
      const expr = condition.expression || '';
      return expr.length > 28 ? `${expr.slice(0, 25)}...` : expr || 'expression';
    }
    default:
      return condition.type;
  }
}

/**
 * Custom React Flow edge component for workflow edges.
 * Renders a dashed line for "never" conditions and a compact label
 * summarizing the condition (e.g. "yes" / "no" on decision branches).
 * Clicking the edge opens the edge condition editor (handled by the canvas).
 *
 * @param {object} props - React Flow edge props
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
  selected,
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

  const condition = data?.condition;
  const isNever = condition?.type === 'never';
  const customLabel =
    data?.label && typeof data.label === 'object'
      ? data.label.en || Object.values(data.label)[0]
      : data?.label;
  const label = customLabel || conditionLabel(condition);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          strokeDasharray: isNever ? '5,5' : undefined,
          stroke: selected ? '#3B82F6' : isNever ? '#9CA3AF' : '#6B7280',
          strokeWidth: selected ? 2 : 1.5
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
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export default ConditionalEdge;
