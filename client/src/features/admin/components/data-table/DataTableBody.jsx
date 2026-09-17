import DataTableEmpty from './DataTableEmpty';
import DataTableLoadingRows from './DataTableLoadingRows';
import DataTableRow from './DataTableRow';

function DataTableBody({
  rows,
  columns,
  actions,
  hasActions,
  kebabThreshold,
  onRowClick,
  getRowId,
  getRowExpansion,
  rowClassName,
  density,
  loading,
  loadingRows,
  empty
}) {
  const totalCols = columns.length + (hasActions ? 1 : 0);

  if (loading) {
    return (
      <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
        <DataTableLoadingRows rows={loadingRows ?? 5} columnCount={totalCols} />
      </tbody>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <tbody className="bg-white dark:bg-gray-900">
        <DataTableEmpty colSpan={totalCols} empty={empty} />
      </tbody>
    );
  }

  return (
    <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
      {rows.map(row => {
        const id = getRowId(row);
        const expansion = getRowExpansion ? getRowExpansion(row) : null;
        return (
          <DataTableRow
            key={id}
            row={row}
            columns={columns}
            actions={actions}
            kebabThreshold={kebabThreshold}
            onRowClick={onRowClick}
            rowClassName={rowClassName}
            density={density}
            expansion={expansion}
          />
        );
      })}
    </tbody>
  );
}

export default DataTableBody;
