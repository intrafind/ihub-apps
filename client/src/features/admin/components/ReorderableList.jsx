import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * A list whose order the admin controls: drag a row with the mouse, or use the
 * up/down buttons. The buttons are the accessible path — pointer drag has no
 * keyboard equivalent — so every row keeps both.
 *
 * `onReorder` receives the whole reordered array; the component holds no copy
 * of the list, so the parent stays the single source of truth.
 *
 * @param {object} props
 * @param {Array} props.items - The items to show, in their current order.
 * @param {(items: Array) => void} props.onReorder - Called with the new order.
 * @param {(item: any) => string} props.getKey - Stable key/id for an item.
 * @param {(item: any, index: number) => React.ReactNode} props.renderItem - Row content.
 * @param {(item: any, index: number) => React.ReactNode} [props.renderActions] - Trailing controls.
 * @param {(item: any) => string} props.getLabel - Accessible name of a row, used in button labels.
 * @param {boolean} [props.disabled] - Render the rows without any reordering affordance.
 */
function ReorderableList({
  items,
  onReorder,
  getKey,
  renderItem,
  renderActions,
  getLabel,
  disabled = false
}) {
  const { t } = useTranslation();
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  const move = (from, to) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);
  };

  const endDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <ul className="space-y-1">
      {items.map((item, index) => {
        const label = getLabel(item);
        const isDragging = dragIndex === index;
        const isDropTarget = overIndex === index && dragIndex !== null && dragIndex !== index;
        return (
          <li
            key={getKey(item)}
            draggable={!disabled}
            onDragStart={e => {
              if (disabled) return;
              setDragIndex(index);
              e.dataTransfer.effectAllowed = 'move';
              // Firefox only starts a drag when some data is set.
              e.dataTransfer.setData('text/plain', String(index));
            }}
            onDragOver={e => {
              if (disabled || dragIndex === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setOverIndex(index);
            }}
            onDrop={e => {
              if (disabled || dragIndex === null) return;
              e.preventDefault();
              move(dragIndex, index);
              endDrag();
            }}
            onDragEnd={endDrag}
            className={`flex items-center gap-2 rounded-md border bg-white dark:bg-gray-700 px-2 py-2 ${
              isDropTarget
                ? 'border-indigo-500 ring-1 ring-indigo-500'
                : 'border-gray-200 dark:border-gray-600'
            } ${isDragging ? 'opacity-50' : ''}`}
          >
            {!disabled && (
              <span
                className="shrink-0 cursor-grab text-gray-400 dark:text-gray-500"
                title={t('admin.reorder.dragHandle', 'Drag to reorder')}
                aria-hidden="true"
              >
                <Icon name="menu" size="sm" />
              </span>
            )}

            <div className="min-w-0 flex-1">{renderItem(item, index)}</div>

            {!disabled && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(index, index - 1)}
                  disabled={index === 0}
                  aria-label={t('admin.reorder.moveUp', 'Move {{name}} up', { name: label })}
                  title={t('admin.reorder.moveUp', 'Move {{name}} up', { name: label })}
                  className="rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Icon name="chevron-up" size="sm" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, index + 1)}
                  disabled={index === items.length - 1}
                  aria-label={t('admin.reorder.moveDown', 'Move {{name}} down', { name: label })}
                  title={t('admin.reorder.moveDown', 'Move {{name}} down', { name: label })}
                  className="rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Icon name="chevron-down" size="sm" />
                </button>
              </div>
            )}

            {renderActions && (
              <div className="flex shrink-0 items-center gap-1">{renderActions(item, index)}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default ReorderableList;
