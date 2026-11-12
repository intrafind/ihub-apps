// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The refresh TTL (#3536) and mode (#3622) of project items in the UI: the
 * choices the dialogs offer, how a TTL reads, and the line an item card shows
 * about its schedule.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RefreshTtlDialog from '../../../client/src/features/projects/components/RefreshTtlDialog';
import {
  hasActiveItems,
  hasAwaitingItems,
  isAwaitingRefresh
} from '../../../client/src/features/projects/utils/projectItems';
import {
  REFRESH_NEVER,
  parseRefreshIdleDays,
  parseRefreshMode,
  parseRefreshTtl,
  refreshModeLabel,
  refreshSummary,
  refreshTtlChoices,
  refreshTtlLabel,
  takesRefreshTtl
} from '../../../client/src/features/projects/utils/refreshTtl';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) =>
      String(typeof fallback === 'string' ? fallback : key).replace(
        /\{\{(\w+)\}\}/g,
        (_m, name) => options?.[name] ?? ''
      ),
    i18n: { language: 'en' }
  })
}));

const t = (key, fallback, options) =>
  String(fallback).replace(/\{\{(\w+)\}\}/g, (_m, name) => options?.[name] ?? '');

describe('refresh TTL helpers', () => {
  it('words a TTL in days, hours or minutes, and never', () => {
    expect(refreshTtlLabel(86400, t)).toBe('1 days');
    expect(refreshTtlLabel(6 * 3600, t)).toBe('6 hours');
    expect(refreshTtlLabel(900, t)).toBe('15 minutes');
    expect(refreshTtlLabel(REFRESH_NEVER, t)).toBe('Never (only by hand)');
  });

  it('offers the usual choices and keeps an unusual current value among them', () => {
    expect(refreshTtlChoices(null).at(-1)).toBe(REFRESH_NEVER);
    const choices = refreshTtlChoices(7200);
    expect(choices).toContain(7200);
    expect(choices.at(-1)).toBe(REFRESH_NEVER);
    expect(choices.slice(0, -1)).toEqual([...choices.slice(0, -1)].sort((a, b) => a - b));
  });

  it('reads a select value back, "" being inherit', () => {
    expect(parseRefreshTtl('')).toBeNull();
    expect(parseRefreshTtl('never')).toBe(REFRESH_NEVER);
    expect(parseRefreshTtl('3600')).toBe(3600);
  });

  it('says when a file or a web page is refreshed next', () => {
    expect(takesRefreshTtl({ kind: 'url' })).toBe(true);
    expect(takesRefreshTtl({ kind: 'upload' })).toBe(false);
    expect(refreshSummary({ refresh: { scheduled: true, ttl: REFRESH_NEVER } }, t, 'en')).toBe(
      'Refreshed only by hand'
    );
    expect(
      refreshSummary(
        { refresh: { scheduled: true, ttl: 3600, nextAt: '2026-11-10T08:00:00.000Z' } },
        t,
        'en'
      )
    ).toMatch(/^Next refresh /);
    expect(refreshSummary({ kind: 'upload' }, t, 'en')).toBeNull();
  });
});

describe('RefreshTtlDialog', () => {
  it('saves an item override, or null to go back to the project setting', async () => {
    const onSave = jest.fn().mockResolvedValue(true);
    const onClose = jest.fn();
    render(
      <RefreshTtlDialog
        scope="item"
        item={{ kind: 'web-file', refresh: { scheduled: true, ttl: 86400, from: 'project' } }}
        value={null}
        inherited={86400}
        onClose={onClose}
        onSave={onSave}
      />
    );
    expect(screen.getByRole('option', { name: 'Project setting (1 days)' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Refresh after'), { target: { value: 'never' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ refreshTtl: 'never' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows a failed save in the dialog', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('Nope'));
    render(
      <RefreshTtlDialog
        scope="project"
        value={3600}
        inherited={86400}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.change(screen.getByLabelText('Refresh after'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ refreshTtl: null }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('sets the refresh mode, and turns it off for a TTL of never', async () => {
    const onSave = jest.fn().mockResolvedValue(true);
    render(
      <RefreshTtlDialog
        scope="project"
        value={null}
        inherited={86400}
        mode={null}
        inheritedMode="auto"
        onClose={() => {}}
        onSave={onSave}
      />
    );
    expect(
      screen.getByRole('option', {
        name: 'Default of this installation (Automatically, while the project is used)'
      })
    ).toBeTruthy();
    const mode = screen.getByLabelText('Refresh');
    fireEvent.change(mode, { target: { value: 'onDemand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ refreshMode: 'onDemand' }));

    fireEvent.change(screen.getByLabelText('Refresh after'), { target: { value: 'never' } });
    expect(mode.disabled).toBe(true);
    expect(screen.getByText('Set to never: refreshed only by hand.')).toBeTruthy();
  });
});

describe('refresh when used (#3622)', () => {
  const outdated = {
    refresh: {
      scheduled: true,
      ttl: 86400,
      background: false,
      expired: true,
      outdatedAt: '2026-11-01T08:00:00.000Z'
    }
  };

  it('says when an on-demand item is refreshed', () => {
    expect(refreshSummary(outdated, t, 'en')).toMatch(/^Outdated since .+, refreshed when used$/);
    expect(refreshSummary({ refresh: { ...outdated.refresh, expired: false } }, t, 'en')).toMatch(
      /^Refreshed when used after /
    );
    expect(refreshModeLabel('onDemand', t)).toBe('When the project is used');
    expect(parseRefreshMode('')).toBeNull();
    expect(parseRefreshMode('auto')).toBe('auto');
  });

  it('reads the idle days, and an emptied field as nothing rather than 0', () => {
    expect(parseRefreshIdleDays('')).toBeNull();
    expect(parseRefreshIdleDays('  ')).toBeNull();
    expect(parseRefreshIdleDays('0')).toBe(0);
    expect(parseRefreshIdleDays('14')).toBe(14);
    expect(parseRefreshIdleDays('1.5')).toBeNull();
    expect(parseRefreshIdleDays('3651')).toBeNull();
  });

  it('tells an outdated item waiting for its refresh on use from one being processed', () => {
    expect(isAwaitingRefresh(outdated)).toBe(true);
    expect(isAwaitingRefresh({ ...outdated, refreshingAt: '2026-11-12T08:00:00.000Z' })).toBe(
      false
    );
    expect(hasAwaitingItems([{ status: 'ready', ...outdated }])).toBe(true);
    // Waiting is not processing: the page polls for it only a few times.
    expect(hasActiveItems([{ status: 'ready', ...outdated }])).toBe(false);
    expect(
      hasAwaitingItems([{ status: 'ready', refresh: { ...outdated.refresh, background: true } }])
    ).toBe(false);
  });
});
