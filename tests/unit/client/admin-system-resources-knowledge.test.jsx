// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AdminSystemResourcesPage from '../../../client/src/features/admin/pages/AdminSystemResourcesPage';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';
import {
  estimateIndexBytes,
  formatHitRate,
  indexCacheCapacityChars
} from '../../../client/src/features/admin/utils/systemResourcesFormat';

/**
 * The System resources page shows the project working set next to the
 * search-index cache (#3652), so an operator can size the cache from data.
 */

// `t` must keep its identity between renders: the page reloads when it changes.
jest.mock('react-i18next', () => {
  const t = (key, fallback, values) => {
    if (typeof fallback !== 'string') return key;
    return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
  };
  const i18n = { language: 'en' };
  const result = { t, i18n };
  return { useTranslation: () => result };
});

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn()
}));

const workerProcess = (overrides = {}) => ({
  role: 'worker',
  workerIndex: 0,
  pid: 101,
  uptimeSeconds: 60,
  cpuPercent: 5,
  current: true,
  memory: { rss: 1, heapUsed: 1, heapLimit: 2 },
  eventLoopDelayMs: null,
  indexCache: { maxChars: 1000, entries: 1, chars: 400 },
  ...overrides
});

const snapshot = (overrides = {}) => ({
  collectedAt: '2026-11-13T00:00:00Z',
  cluster: { mode: 'cluster', configuredWorkers: 1, missingWorkers: [], primaryReported: true },
  host: {
    cpu: { cores: 2, loadAverage: [0, 0, 0] },
    memory: { total: 1, used: 0, available: 1, usedPercent: 0, containerLimited: false }
  },
  storage: { status: 'ok', thresholds: {}, volumes: [] },
  processes: [workerProcess()],
  workingSet: {
    windows: [
      { minutes: 5, projects: 2, chars: 1200 },
      { minutes: 15, projects: 3, chars: 1500 },
      { minutes: 60, projects: 9, chars: 4000 }
    ]
  },
  knowledge: {
    indexCache: { hits: 30, misses: 10, evictions: 4, entries: 3, chars: 900, hitRate: 0.75 }
  },
  ...overrides
});

async function renderWith(data) {
  makeAdminApiCall.mockResolvedValue({ data });
  render(<AdminSystemResourcesPage />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('System resources: project knowledge', () => {
  afterEach(() => jest.clearAllMocks());

  test('shows the working set per window and the cache statistics', async () => {
    await renderWith(snapshot());

    const section = screen.getByRole('heading', { name: 'Project knowledge' }).closest('section');
    const rows = within(section).getAllByRole('row');
    // header + 5, 15 and 60 minutes
    expect(rows).toHaveLength(4);
    expect(within(rows[3]).getByText('9')).toBeInTheDocument();
    expect(within(rows[3]).getByText('4,000')).toBeInTheDocument();
    // 4 000 characters x 4.5 bytes
    expect(within(rows[3]).getByText('17.6 KB')).toBeInTheDocument();

    expect(within(section).getByText('75%')).toBeInTheDocument();
    expect(within(section).getByText('Misses (index builds)')).toBeInTheDocument();
    expect(within(section).getByText('Each worker caches', { exact: false })).toBeInTheDocument();
  });

  test('warns when the recent working set outgrows one worker cache', async () => {
    // 15-minute window: 1 500 characters against a 1 000 character cache.
    await renderWith(snapshot());
    expect(screen.getByText('Expect cache misses', { exact: false })).toBeInTheDocument();
  });

  test('no warning while the working set fits', async () => {
    await renderWith(
      snapshot({
        processes: [workerProcess({ indexCache: { maxChars: 5000, entries: 1, chars: 10 } })]
      })
    );
    expect(screen.queryByText('Expect cache misses', { exact: false })).not.toBeInTheDocument();
  });

  test('a server without the new fields renders no knowledge section', async () => {
    const older = snapshot();
    delete older.workingSet;
    delete older.knowledge;
    await renderWith(older);
    expect(screen.getByRole('heading', { name: 'Server processes' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Project knowledge' })).not.toBeInTheDocument();
  });
});

describe('system resources knowledge helpers', () => {
  test('hit rate is a percentage, and a dash before any lookup', () => {
    expect(formatHitRate(0.5)).toBe('50%');
    expect(formatHitRate(null)).toBe('—');
  });

  test('index memory is 4.5 bytes per character', () => {
    expect(estimateIndexBytes(1000)).toBe(4500);
    expect(estimateIndexBytes(undefined)).toBeNull();
  });

  test('capacity is the largest any process reports', () => {
    expect(
      indexCacheCapacityChars([
        { indexCache: { maxChars: 10 } },
        { indexCache: { maxChars: 30 } },
        {}
      ])
    ).toBe(30);
    expect(indexCacheCapacityChars([])).toBe(0);
  });
});
