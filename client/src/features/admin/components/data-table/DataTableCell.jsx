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

const MAX_WIDTH = {
  xs: 'max-w-[10rem]',
  sm: 'max-w-[14rem]',
  md: 'max-w-[20rem]',
  lg: 'max-w-[28rem]',
  xl: 'max-w-[36rem]'
};

const DEFAULT_MAX_WIDTH = 'max-w-[24rem]';

const LINE_CLAMP = {
  1: 'truncate',
  2: 'line-clamp-2',
  3: 'line-clamp-3'
};

function DataTableCell({ column, row, density = 'normal' }) {
  const padY = density === 'compact' ? 'py-1.5' : 'py-3';
  const content =
    typeof column.render === 'function' ? column.render(row) : (row[column.key] ?? '');

  const widthClass = column.maxWidth ? MAX_WIDTH[column.maxWidth] || '' : DEFAULT_MAX_WIDTH;
  const clampClass = column.truncate
    ? LINE_CLAMP[1]
    : column.maxLines
      ? LINE_CLAMP[column.maxLines] || ''
      : '';
  // Multi-line content needs top-alignment; single-line columns look better
  // centered. Truncate/clamp columns and explicit opt-ins use `align-top`.
  const vAlign =
    column.valign === 'top' || column.truncate || column.maxLines ? 'align-top' : 'align-middle';

  const cellClass = [
    'px-4',
    padY,
    vAlign,
    'text-sm text-gray-900 dark:text-gray-100',
    ALIGN[column.align] || ALIGN.left,
    column.hideBelow ? HIDE_BELOW[column.hideBelow] : '',
    // Width clamp prevents columns from being stretched by long values.
    // Override per-column via `width` (e.g. `'w-32'`) or `maxWidth: 'xs'|'sm'|'md'|'lg'|'xl'`.
    column.width || widthClass,
    column.className || ''
  ]
    .filter(Boolean)
    .join(' ');

  // Wrap so nested truncate/clamp rules work even with table-layout: auto.
  const wrapperClass = ['min-w-0 max-w-full', clampClass].filter(Boolean).join(' ');

  return (
    <td className={cellClass}>
      <div className={wrapperClass}>{content}</div>
    </td>
  );
}

export default DataTableCell;
