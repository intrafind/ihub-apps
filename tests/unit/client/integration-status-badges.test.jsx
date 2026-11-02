// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The badges of an installation (tile and page header) on the shared Badge
 * and StatusDot (intrafind/ihub-apps#2925): the texts and test ids stay, each
 * state keeps its colour (enabled green, disabled amber, failed red, …), and
 * the live status carries a StatusDot whose status matches its text.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, options) =>
      typeof defaultValue === 'string'
        ? defaultValue.replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '')
        : key,
    i18n: { language: 'en' }
  })
}));

const {
  InstallationStatusPills,
  MigrationStatusPill
} = require('../../../client/src/features/admin/components/integrations/IntegrationPills');

/**
 * Renders the badges of an installation.
 *
 * @param {Object} item - an installation as the admin API lists it
 */
function renderPills(item) {
  return render(
    <MemoryRouter>
      <div data-testid="pills">
        <InstallationStatusPills item={{ id: 'x', ...item }} />
      </div>
    </MemoryRouter>
  );
}

/** The badge element (outermost span) that holds `text`. */
function badgeOf(text) {
  let node = screen.getByText(text);
  while (node.parentElement && node.parentElement.dataset.testid !== 'pills') {
    if (node.parentElement.tagName === 'A') break;
    node = node.parentElement;
  }
  return node;
}

describe('InstallationStatusPills', () => {
  it('keeps the colour of enabled, disabled, always installed and missing definition', () => {
    const { unmount } = renderPills({ enabled: true, locked: true, definitionMissing: true });
    expect(badgeOf('Enabled')).toHaveClass('bg-green-100', 'rounded-full', 'text-xs');
    expect(badgeOf('Always installed')).toHaveClass('bg-blue-100');
    expect(badgeOf('Definition missing')).toHaveClass('bg-red-100');
    unmount();

    renderPills({ enabled: false });
    expect(badgeOf('Disabled')).toHaveClass('bg-amber-100');
  });

  it('keeps the version tooltip, the update link and their test ids', () => {
    renderPills({
      definitionVersion: '1.2.0',
      currentVersion: '1.3.0',
      updateAvailable: true,
      latestVersion: '1.4.0',
      definition: 'org.ckan/open-data-portal'
    });
    const version = screen.getByTestId('installed-version');
    expect(version).toHaveTextContent('v1.2.0');
    expect(version.parentElement).toHaveAttribute('title', 'Definition on disk: v1.3.0');

    const update = screen.getByTestId('update-badge');
    expect(update.tagName).toBe('A');
    expect(update).toHaveTextContent('Update to v1.4.0 available');
    expect(update.firstChild).toHaveClass('bg-amber-100');
  });

  it.each([
    [{ connected: true, toolCount: 3 }, 'ok', 'Connected · 3 tools', 'bg-green-100'],
    [{ unhealthy: true }, 'error', 'Unreachable', 'bg-red-100'],
    [{ connected: false }, 'off', 'Not connected', 'bg-gray-100'],
    [{ perUser: true, userConnections: 2 }, 'ok', '2 connected users', 'bg-green-100']
  ])('shows live status %j with a "%s" dot', (liveStatus, status, text, background) => {
    renderPills({ enabled: true, liveStatus });

    const live = screen.getByTestId('live-status');
    expect(live).toHaveAttribute('data-status', status);
    expect(live).toHaveTextContent(text);
    // The text is visible once, in the badge's own text style.
    expect(screen.getByText(text)).not.toHaveClass('sr-only');
    expect(live.parentElement).toHaveClass(background, 'rounded-full', 'text-xs');
  });

  it('shows no live status for a disabled installation', () => {
    renderPills({ enabled: false, liveStatus: { connected: true } });
    expect(screen.queryByTestId('live-status')).not.toBeInTheDocument();
  });

  it('colours the directory transport by how it is protected', () => {
    renderPills({ enabled: true, liveStatus: { transport: 'plaintext' } });
    expect(badgeOf('plaintext')).toHaveClass('bg-red-100');
  });
});

describe('MigrationStatusPill', () => {
  it.each([
    ['migrationFailed', 'Migration failed', 'bg-red-100'],
    ['migrationPending', 'Migration pending', 'bg-amber-100'],
    ['needsReview', 'Needs review', 'bg-amber-100']
  ])('%s is "%s" on %s', (status, text, background) => {
    render(<MigrationStatusPill status={status} />);
    const pill = screen.getByTestId('migration-status');
    expect(pill).toHaveTextContent(text);
    expect(pill.parentElement).toHaveClass(background);
  });

  it('renders nothing without a migration state', () => {
    const { container } = render(<MigrationStatusPill status={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
