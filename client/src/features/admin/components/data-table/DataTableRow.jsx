import DataTableCell from './DataTableCell';
import DataTableRowActions from './DataTableRowActions';

function DataTableRow({
  row,
  columns,
  actions,
  kebabThreshold,
  onRowClick,
  rowClassName,
  density,
  expansion
}) {
  const interactive = typeof onRowClick === 'function';
  const baseClass = [
    'group',
    'hover:bg-gray-50 dark:hover:bg-gray-800',
    interactive ? 'cursor-pointer' : '',
    rowClassName ? rowClassName(row) : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <tr className={baseClass} onClick={interactive ? () => onRowClick(row) : undefined}>
        {columns.map(column => (
          <DataTableCell key={column.key} column={column} row={row} density={density} />
        ))}
        {actions && actions.length > 0 && (
          <DataTableRowActions
            actions={actions}
            row={row}
            kebabThreshold={kebabThreshold}
            density={density}
          />
        )}
      </tr>
      {expansion && expansion.expanded && (
        <tr className="bg-gray-50 dark:bg-gray-800/40">
          <td
            colSpan={columns.length + (actions && actions.length > 0 ? 1 : 0)}
            className="px-4 py-3 text-sm text-gray-700 dark:text-gray-200"
          >
            {expansion.content}
          </td>
        </tr>
      )}
    </>
  );
}

export default DataTableRow;
