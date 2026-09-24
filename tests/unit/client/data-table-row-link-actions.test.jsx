import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * DataTable link actions — used by the apps list's "Open app" action
 * (issue #2510): a link can open in a new tab, a row-dependent title explains
 * a disabled action, and a disabled link renders as a disabled button.
 */

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

import DataTableRowActions from '../../../client/src/features/admin/components/data-table/DataTableRowActions';

const openAction = {
  id: 'open',
  label: 'Open app',
  title: row => (row.enabled ? 'Open the app in a new tab' : 'Enable the app to open it'),
  icon: 'external-link',
  priority: 'primary',
  href: row => `/apps/${row.id}`,
  target: '_blank',
  disabled: row => !row.enabled
};

function renderActions(row) {
  return render(
    <table>
      <tbody>
        <tr>
          <DataTableRowActions actions={[openAction]} row={row} />
        </tr>
      </tbody>
    </table>
  );
}

test('an enabled row gets a new-tab link', () => {
  renderActions({ id: 'chat', enabled: true });
  const link = screen.getByRole('link', { name: 'Open app' });
  expect(link).toHaveAttribute('href', '/apps/chat');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(link).toHaveAttribute('title', 'Open the app in a new tab');
});

test('a disabled row gets a disabled button that says why', () => {
  renderActions({ id: 'chat', enabled: false });
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Open app' });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('title', 'Enable the app to open it');
});
