import Icon from '../../../../shared/components/Icon';
import { DEFAULT_PAGE_SIZE_OPTIONS } from './useTablePagination';

function buildPageList(current, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = new Set([1, totalPages, current, current - 1, current + 1]);
  const list = [...pages]
    .filter(p => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b)
    .reduce((acc, p) => {
      if (acc.length === 0) return [p];
      const last = acc[acc.length - 1];
      if (last !== '…' && p - last > 1) acc.push('…');
      acc.push(p);
      return acc;
    }, []);
  return list;
}

function PageButton({ children, disabled, active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={[
        'inline-flex items-center justify-center min-w-[2rem] h-8 px-2 rounded-md text-sm',
        'border border-gray-200 dark:border-gray-700',
        active
          ? 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700'
          : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800',
        'disabled:opacity-40 disabled:cursor-not-allowed'
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function DataTablePagination({
  page,
  pageSize,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  total,
  onPageChange,
  onPageSizeChange,
  labels = {}
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(total, safePage * pageSize);
  const showing =
    typeof labels.showing === 'function'
      ? labels.showing(start, end, total)
      : `Showing ${start}–${end} of ${total}`;

  const pages = buildPageList(safePage, totalPages);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      <div className="text-sm text-gray-600 dark:text-gray-400">{showing}</div>
      <div className="flex items-center gap-3">
        <label className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
          <span>{labels.rowsPerPage || 'Rows per page'}</span>
          <select
            value={pageSize}
            onChange={e => onPageSizeChange && onPageSizeChange(Number(e.target.value))}
            className="text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {pageSizeOptions.map(size => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1">
          <PageButton
            onClick={() => onPageChange(1)}
            disabled={safePage === 1}
            label={labels.first || 'First page'}
          >
            <Icon name="chevron-double-left" size="xs" />
          </PageButton>
          <PageButton
            onClick={() => onPageChange(safePage - 1)}
            disabled={safePage === 1}
            label={labels.previous || 'Previous'}
          >
            <Icon name="chevron-left" size="xs" />
          </PageButton>
          {pages.map((p, i) =>
            p === '…' ? (
              // eslint-disable-next-line @eslint-react/no-array-index-key
              <span key={`gap-${i}`} className="px-1 text-gray-400">
                …
              </span>
            ) : (
              <PageButton
                key={p}
                active={p === safePage}
                onClick={() => onPageChange(p)}
                label={`Page ${p}`}
              >
                {p}
              </PageButton>
            )
          )}
          <PageButton
            onClick={() => onPageChange(safePage + 1)}
            disabled={safePage === totalPages}
            label={labels.next || 'Next'}
          >
            <Icon name="chevron-right" size="xs" />
          </PageButton>
          <PageButton
            onClick={() => onPageChange(totalPages)}
            disabled={safePage === totalPages}
            label={labels.last || 'Last page'}
          >
            <Icon name="chevron-double-right" size="xs" />
          </PageButton>
        </div>
      </div>
    </div>
  );
}

export default DataTablePagination;
