import Icon from '../../../../shared/components/Icon';
import DataTableKebabMenu from './DataTableKebabMenu';

/**
 * Split an action list into "inline" (rendered as icon buttons) and "overflow"
 * (rendered as kebab-menu items), respecting `priority`, `destructive`, and a
 * threshold. Hidden actions are pre-filtered.
 */
export function splitActions(actions, row, kebabThreshold = 3) {
  const visible = (actions || []).filter(a => !(a.hidden && a.hidden(row)));
  if (visible.length === 0) return { inline: [], overflow: [] };
  if (visible.length < kebabThreshold) return { inline: visible, overflow: [] };

  const inline = [];
  const overflow = [];
  // Explicit priority always wins
  const explicitPrimary = visible.filter(a => a.priority === 'primary');
  const explicitSecondary = visible.filter(a => a.priority === 'secondary');
  const unranked = visible.filter(a => !a.priority);

  if (explicitPrimary.length > 0 || explicitSecondary.length > 0) {
    explicitPrimary.forEach(a => inline.push(a));
    // First unranked acts as a primary if no explicit primary
    if (explicitPrimary.length === 0 && unranked.length > 0) inline.push(unranked[0]);
    const rest = explicitPrimary.length === 0 ? unranked.slice(1) : unranked;
    rest.forEach(a => (a.destructive ? inline.push(a) : overflow.push(a)));
    explicitSecondary.forEach(a => overflow.push(a));
    return { inline, overflow };
  }

  // No explicit priority — first non-destructive is "primary", destructive stays inline.
  const firstPrimary = unranked.find(a => !a.destructive);
  unranked.forEach(a => {
    if (a === firstPrimary || a.destructive) inline.push(a);
    else overflow.push(a);
  });
  return { inline, overflow };
}

function ActionButton({ action, row }) {
  const disabled = action.disabled ? action.disabled(row) : false;
  const busy = action.busy ? action.busy(row) : false;
  const colorClass = action.destructive
    ? 'text-red-600 hover:text-red-800 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/30'
    : 'text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 dark:text-gray-400 dark:hover:text-indigo-300 dark:hover:bg-indigo-900/30';

  const className = [
    'p-1.5 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500',
    colorClass,
    action.className || '',
    'disabled:opacity-50 disabled:cursor-not-allowed'
  ].join(' ');

  const content = busy ? (
    <Icon name="refresh" size="sm" className="animate-spin" />
  ) : (
    <Icon name={action.icon || 'pencil'} size="sm" />
  );

  if (action.href) {
    return (
      <a
        href={action.href(row)}
        title={action.title || action.label}
        aria-label={action.label}
        className={className}
        onClick={e => {
          if (action.onClick) {
            e.preventDefault();
            action.onClick(row);
          }
        }}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={() => action.onClick && action.onClick(row)}
      title={action.title || action.label}
      aria-label={action.label}
      className={className}
    >
      {content}
    </button>
  );
}

function DataTableRowActions({ actions, row, kebabThreshold = 3, density = 'normal' }) {
  const { inline, overflow } = splitActions(actions, row, kebabThreshold);
  const padY = density === 'compact' ? 'py-1.5' : 'py-3';

  return (
    <td
      className={[
        'sticky right-0 z-10 px-3',
        padY,
        'whitespace-nowrap text-right',
        'bg-white dark:bg-gray-900',
        'group-hover:bg-gray-50 dark:group-hover:bg-gray-800',
        'shadow-[inset_1px_0_0_rgba(0,0,0,0.06)] dark:shadow-[inset_1px_0_0_rgba(255,255,255,0.08)]'
      ].join(' ')}
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-end gap-1">
        {inline.map(action => (
          <ActionButton key={action.id} action={action} row={row} />
        ))}
        {overflow.length > 0 && <DataTableKebabMenu items={overflow} row={row} />}
      </div>
    </td>
  );
}

export default DataTableRowActions;
