import { useMemo } from 'react';

export const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Slice a sorted/filtered list into a page. Client mode only.
 */
export function usePagedRows(rows, page, pageSize) {
  return useMemo(() => {
    const start = Math.max(0, (page - 1) * pageSize);
    return rows.slice(start, start + pageSize);
  }, [rows, page, pageSize]);
}

/**
 * Normalize pagination config into a uniform internal shape used by DataTable.
 * `false` → disabled. Falsy/undefined → defaults to client mode.
 */
export function normalizePagination(pagination) {
  if (pagination === false) return null;
  if (!pagination) {
    return {
      mode: 'client',
      pageSize: DEFAULT_PAGE_SIZE,
      pageSizeOptions: DEFAULT_PAGE_SIZE_OPTIONS
    };
  }
  return {
    mode: pagination.mode || 'client',
    pageSize: pagination.pageSize ?? DEFAULT_PAGE_SIZE,
    pageSizeOptions: pagination.pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS,
    total: pagination.total,
    page: pagination.page,
    onPageChange: pagination.onPageChange,
    onPageSizeChange: pagination.onPageSizeChange
  };
}
