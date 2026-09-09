import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * ReorderableList — the admin control behind "Reorder" in Admin → Apps and the
 * default-app list under UI Customization → Start Page (issue #2297).
 *
 * Pointer drag has no keyboard equivalent, so the up/down buttons are the
 * accessible path and must produce exactly the same order as a drag. The
 * component owns no copy of the list: every move reports the whole new order
 * back to the parent.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, opts) => {
      let str = defaultValue ?? key;
      if (opts && typeof str === 'string') {
        for (const [k, v] of Object.entries(opts)) {
          str = str.replace(new RegExp(`{{${k}}}`, 'g'), v);
        }
      }
      return str;
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`}>{name}</span>;
  };
});

import ReorderableList from '../../../client/src/features/admin/components/ReorderableList';

const ITEMS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' }
];

const renderList = (props = {}) => {
  const onReorder = jest.fn();
  const utils = render(
    <ReorderableList
      items={ITEMS}
      onReorder={onReorder}
      getKey={item => item.id}
      getLabel={item => item.label}
      renderItem={item => <span>{item.label}</span>}
      {...props}
    />
  );
  return { onReorder, ...utils };
};

const dragTo = (from, to) => {
  const rows = screen.getAllByRole('listitem');
  const data = {};
  const dataTransfer = {
    setData: (type, value) => {
      data[type] = value;
    },
    getData: type => data[type]
  };
  fireEvent.dragStart(rows[from], { dataTransfer });
  fireEvent.dragOver(rows[to], { dataTransfer });
  fireEvent.drop(rows[to], { dataTransfer });
};

describe('ReorderableList', () => {
  test('renders every item with both move buttons', () => {
    renderList();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByLabelText('Move Alpha down')).toBeInTheDocument();
    expect(screen.getByLabelText('Move Gamma up')).toBeInTheDocument();
  });

  test('the arrow buttons report the whole reordered list', () => {
    const { onReorder } = renderList();

    fireEvent.click(screen.getByLabelText('Move Gamma up'));

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder.mock.calls[0][0].map(item => item.id)).toEqual(['a', 'c', 'b']);
  });

  test('moving down is the mirror of moving up', () => {
    const { onReorder } = renderList();

    fireEvent.click(screen.getByLabelText('Move Alpha down'));

    expect(onReorder.mock.calls[0][0].map(item => item.id)).toEqual(['b', 'a', 'c']);
  });

  test('the list stays put until the parent re-renders it', () => {
    // The component holds no copy of the order, so one click can never move an
    // item twice — the parent is the single source of truth.
    const { onReorder } = renderList();

    fireEvent.click(screen.getByLabelText('Move Gamma up'));
    fireEvent.click(screen.getByLabelText('Move Gamma up'));

    expect(onReorder).toHaveBeenCalledTimes(2);
    expect(onReorder.mock.calls[1][0].map(item => item.id)).toEqual(['a', 'c', 'b']);
  });

  test('the ends cannot be moved off the list', () => {
    const { onReorder } = renderList();

    expect(screen.getByLabelText('Move Alpha up')).toBeDisabled();
    expect(screen.getByLabelText('Move Gamma down')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Move Alpha up'));
    expect(onReorder).not.toHaveBeenCalled();
  });

  test('dragging a row onto another lands it in that position', () => {
    const { onReorder } = renderList();

    dragTo(2, 0);

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder.mock.calls[0][0].map(item => item.id)).toEqual(['c', 'a', 'b']);
  });

  test('dropping a row on itself changes nothing', () => {
    const { onReorder } = renderList();

    dragTo(1, 1);

    expect(onReorder).not.toHaveBeenCalled();
  });

  test('trailing actions render next to each row', () => {
    renderList({
      renderActions: item => <button aria-label={`Remove ${item.label}`} />
    });

    expect(screen.getByLabelText('Remove Beta')).toBeInTheDocument();
  });

  test('disabled drops every reordering affordance', () => {
    renderList({ disabled: true });

    expect(screen.queryByLabelText('Move Alpha down')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[0]).not.toHaveAttribute('draggable', 'true');
  });
});
