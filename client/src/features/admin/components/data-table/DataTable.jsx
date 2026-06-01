import { useMemo, useState } from 'react';
import DataTableBody from './DataTableBody';
import DataTableHeader from './DataTableHeader';
import DataTablePagination from './DataTablePagination';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PAGE_SIZE_OPTIONS,
  normalizePagination,
  usePagedRows
} from './useTablePagination';
import { useSortedRows } from './useTableSort';

/**
 * Shared admin data table.
 *
 * @template Row
 * @param {Object} props
 * @param {Array} props.columns
 * @param {Array<Row>} props.data
 * @param {(row: Row) => string} props.getRowId
 * @param {{column: string, direction: 'asc'|'desc'}|null} [props.sort]  Controlled sort
 * @param {(next) => void} [props.onSortChange]
 * @param {{column: string, direction: 'asc'|'desc'}|null} [props.defaultSort]
 * @param {Array} [props.actions]
 * @param {number} [props.kebabThreshold]  Default 3
 * @param {(row: Row) => void} [props.onRowClick]
 * @param {(row: Row) => {expanded: boolean, content: ReactNode}|null} [props.getRowExpansion]
 * @param {(row: Row) => string} [props.rowClassName]
 * @param {boolean} [props.loading]
 * @param {number} [props.loadingRows]
 * @param {{icon?: string, title: string, description?: string, action?: ReactNode}} [props.empty]
 * @param {'compact'|'normal'} [props.density]  Default 'normal'
 * @param {boolean} [props.stickyHeader]  Default true
 * @param {false|object} [props.pagination]  See useTablePagination.normalizePagination
 * @param {object} [props.labels]
 */
function DataTable({
  columns,
  data,
  getRowId,
  sort,
  onSortChange,
  defaultSort = null,
  actions,
  kebabThreshold = 3,
  onRowClick,
  getRowExpansion,
  rowClassName,
  loading = false,
  loadingRows,
  empty,
  density = 'normal',
  stickyHeader = true,
  pagination,
  labels
}) {
  const isControlledSort = sort !== undefined;
  const [internalSort, setInternalSort] = useState(defaultSort);
  const activeSort = isControlledSort ? sort : internalSort;

  const paginationConfig = useMemo(() => normalizePagination(pagination), [pagination]);
  const isServerPaged = paginationConfig?.mode === 'server';

  const sortedRows = useSortedRows(data || [], activeSort, columns);

  // Client paging state — uncontrolled
  const [internalPage, setInternalPage] = useState(1);
  const [internalPageSize, setInternalPageSize] = useState(
    paginationConfig?.pageSize ?? DEFAULT_PAGE_SIZE
  );

  const handleSortChange = next => {
    if (isControlledSort) onSortChange && onSortChange(next);
    else setInternalSort(next);
    if (paginationConfig?.mode === 'client') setInternalPage(1);
    if (paginationConfig?.mode === 'server' && paginationConfig.onPageChange) {
      paginationConfig.onPageChange(1);
    }
  };

  const currentPage = isServerPaged
    ? paginationConfig.page
    : sortedRows.length === 0
      ? 1
      : internalPage;
  const currentPageSize = isServerPaged ? paginationConfig.pageSize : internalPageSize;

  const pagedRows = usePagedRows(sortedRows, currentPage, currentPageSize);
  const visibleRows = isServerPaged ? sortedRows : paginationConfig ? pagedRows : sortedRows;

  const total = isServerPaged ? paginationConfig.total : sortedRows.length;

  const handlePageChange = next => {
    if (isServerPaged) paginationConfig.onPageChange(next);
    else setInternalPage(next);
  };
  const handlePageSizeChange = next => {
    if (isServerPaged) {
      paginationConfig.onPageSizeChange && paginationConfig.onPageSizeChange(next);
      paginationConfig.onPageChange(1);
    } else {
      setInternalPageSize(next);
      setInternalPage(1);
    }
  };

  // Hide pagination footer in client mode when the data fits in the smallest page-size option
  const pageSizeOptions = paginationConfig?.pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS;
  const showPaginationFooter =
    !!paginationConfig &&
    (isServerPaged || (sortedRows.length > Math.min(...pageSizeOptions) && !loading));

  const hasActions = Array.isArray(actions) && actions.length > 0;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <DataTableHeader
            columns={columns}
            sort={activeSort}
            onSortChange={handleSortChange}
            hasActions={hasActions}
            stickyHeader={stickyHeader}
          />
          <DataTableBody
            rows={visibleRows}
            columns={columns}
            actions={actions}
            hasActions={hasActions}
            kebabThreshold={kebabThreshold}
            onRowClick={onRowClick}
            getRowId={getRowId}
            getRowExpansion={getRowExpansion}
            rowClassName={rowClassName}
            density={density}
            loading={loading}
            loadingRows={loadingRows}
            empty={empty}
          />
        </table>
      </div>
      {showPaginationFooter && (
        <DataTablePagination
          page={currentPage}
          pageSize={currentPageSize}
          pageSizeOptions={pageSizeOptions}
          total={total}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
          labels={labels}
        />
      )}
    </div>
  );
}

export default DataTable;
