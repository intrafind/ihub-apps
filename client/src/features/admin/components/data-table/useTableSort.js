import { useCallback, useMemo, useState } from 'react';

/**
 * Serialize sort state to URL token: "column:direction" or "" when null.
 */
export function formatSortParam(sort) {
  if (!sort || !sort.column || !sort.direction) return '';
  return `${sort.column}:${sort.direction}`;
}

/**
 * Parse URL token back into a SortState object. Returns null when empty/invalid.
 */
export function parseSortParam(value) {
  if (!value || typeof value !== 'string') return null;
  const [column, direction] = value.split(':');
  if (!column || (direction !== 'asc' && direction !== 'desc')) return null;
  return { column, direction };
}

/**
 * Click cycle: unsorted -> asc -> desc -> unsorted.
 */
export function nextSort(current, columnKey) {
  if (!current || current.column !== columnKey) {
    return { column: columnKey, direction: 'asc' };
  }
  if (current.direction === 'asc') return { column: columnKey, direction: 'desc' };
  return null;
}

/**
 * Uncontrolled-sort hook for pages that don't URL-sync their sort state.
 */
export function useUncontrolledSort(defaultSort = null) {
  const [sort, setSort] = useState(defaultSort);
  const toggle = useCallback(columnKey => setSort(prev => nextSort(prev, columnKey)), []);
  return [sort, setSort, toggle];
}

function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const aStr = String(a);
  const bStr = String(b);
  // Date strings — parse on the fly
  const aDate = Date.parse(aStr);
  const bDate = Date.parse(bStr);
  if (!Number.isNaN(aDate) && !Number.isNaN(bDate) && /\d{4}-\d{2}-\d{2}/.test(aStr)) {
    return aDate - bDate;
  }
  return aStr.localeCompare(bStr, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Client-side sorter. Pass through original array when sort is null.
 */
export function useSortedRows(rows, sort, columns) {
  return useMemo(() => {
    if (!sort || !sort.column) return rows;
    const column = columns.find(c => (c.sortKey ?? c.key) === sort.column || c.key === sort.column);
    if (!column) return rows;
    const accessor = column.sortAccessor || (row => row[column.sortKey ?? column.key]);
    const sorted = [...rows].sort((rowA, rowB) => compareValues(accessor(rowA), accessor(rowB)));
    return sort.direction === 'desc' ? sorted.reverse() : sorted;
  }, [rows, sort, columns]);
}
