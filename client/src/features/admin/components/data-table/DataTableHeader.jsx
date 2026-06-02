import Icon from '../../../../shared/components/Icon';
import { nextSort } from './useTableSort';

const HIDE_BELOW = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell'
};

const ALIGN = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center'
};

function SortIndicator({ active, direction }) {
  if (!active) {
    return (
      <Icon
        name="chevron-up-down"
        size="xs"
        className="ml-1 inline-block text-gray-300 dark:text-gray-600 opacity-0 group-hover/th:opacity-100 transition-opacity"
      />
    );
  }
  return (
    <Icon
      name={direction === 'asc' ? 'chevron-up' : 'chevron-down'}
      size="xs"
      className="ml-1 inline-block text-gray-600 dark:text-gray-300"
    />
  );
}

function DataTableHeader({ columns, sort, onSortChange, hasActions, stickyHeader = true }) {
  const handleSortClick = column => {
    if (!column.sortable || !onSortChange) return;
    onSortChange(nextSort(sort, column.sortKey ?? column.key));
  };

  return (
    <thead
      className={['bg-gray-50 dark:bg-gray-800/60', stickyHeader ? 'sticky top-0 z-10' : ''].join(
        ' '
      )}
    >
      <tr>
        {columns.map(column => {
          const sortKey = column.sortKey ?? column.key;
          const isSorted = sort && sort.column === sortKey;
          const baseClass = [
            'px-4 py-2.5 text-xs font-semibold uppercase tracking-wider',
            'text-gray-500 dark:text-gray-400 whitespace-nowrap',
            ALIGN[column.align] || ALIGN.left,
            column.hideBelow ? HIDE_BELOW[column.hideBelow] : '',
            column.width || '',
            column.thClassName || ''
          ]
            .filter(Boolean)
            .join(' ');

          if (!column.sortable) {
            return (
              <th key={column.key} scope="col" className={baseClass}>
                {column.header}
              </th>
            );
          }
          const ariaSort = isSorted
            ? sort.direction === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none';
          return (
            <th key={column.key} scope="col" className={baseClass} aria-sort={ariaSort}>
              <button
                type="button"
                onClick={() => handleSortClick(column)}
                className="group/th inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none focus:text-gray-900 dark:focus:text-gray-100"
              >
                <span>{column.header}</span>
                <SortIndicator active={isSorted} direction={isSorted ? sort.direction : null} />
              </button>
            </th>
          );
        })}
        {hasActions && (
          <th
            scope="col"
            className="sticky right-0 z-20 bg-gray-50 dark:bg-gray-800/60 px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 whitespace-nowrap shadow-[inset_1px_0_0_rgba(0,0,0,0.12)] dark:shadow-[inset_1px_0_0_rgba(255,255,255,0.14)]"
          >
            <span className="sr-only">Actions</span>
          </th>
        )}
      </tr>
    </thead>
  );
}

export default DataTableHeader;
