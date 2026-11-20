/**
 * Admin → System resources: disk volumes with their status, host CPU/memory,
 * and one row per server process — including a flagged row for a cluster
 * worker that did not answer, which must never just vanish from the table.
 *
 * Only the admin API and the translation hook are stubbed.
 */
import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';

const mockMakeAdminApiCall = jest.fn();
const mockFetchStorageStatus = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  fetchStorageStatus: (...args) => mockFetchStorageStatus(...args),
  testStorage: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || ''
}));

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
}));

import AdminSystemResourcesPage from '../../../client/src/features/admin/pages/AdminSystemResourcesPage';

const GiB = 1024 ** 3;

function processEntry(overrides) {
  return {
    role: 'worker',
    workerIndex: 0,
    pid: 100,
    uptimeSeconds: 3700,
    cpuPercent: 12.5,
    memory: { rss: 256 * 1024 ** 2, heapUsed: 80 * 1024 ** 2, heapLimit: 4 * GiB },
    eventLoopDelayMs: { mean: 1.2, max: 8 },
    sampledAt: '2026-09-30T10:00:00.000Z',
    current: false,
    ...overrides
  };
}

function snapshot(overrides = {}) {
  return {
    collectedAt: '2026-09-30T10:00:05.000Z',
    cluster: { mode: 'cluster', configuredWorkers: 3, missingWorkers: [2], primaryReported: true },
    host: {
      hostname: 'ihub-host',
      platform: 'linux',
      arch: 'x64',
      osRelease: '6.1.0',
      nodeVersion: 'v24.1.0',
      uptimeSeconds: 90000,
      cpu: {
        model: 'Test CPU',
        cores: 4,
        limitCores: 2,
        utilizationPercent: 35,
        loadAverage: [0.5, 0.4, 0.3]
      },
      memory: {
        total: 8 * GiB,
        available: 2 * GiB,
        used: 6 * GiB,
        usedPercent: 75,
        containerLimited: true,
        hostTotal: 32 * GiB
      }
    },
    storage: {
      status: 'critical',
      thresholds: { warningPercent: 80, criticalPercent: 90 },
      volumes: [
        {
          paths: [
            { key: 'contents', path: '/app/contents' },
            { key: 'data', path: '/app/contents/data' }
          ],
          total: 20 * GiB,
          used: 19 * GiB,
          available: 1 * GiB,
          usedPercent: 95,
          status: 'critical'
        },
        {
          paths: [{ key: 'temp', path: '/tmp' }],
          total: 100 * GiB,
          used: 10 * GiB,
          available: 90 * GiB,
          usedPercent: 10,
          status: 'ok'
        }
      ]
    },
    processes: [
      processEntry({ role: 'primary', workerIndex: null, pid: 1 }),
      processEntry({ workerIndex: 0, pid: 100, current: true }),
      processEntry({ workerIndex: 1, pid: 101 })
    ],
    ...overrides
  };
}

/** A disk snapshot with nothing to warn about. */
function healthyStorage() {
  return {
    status: 'ok',
    thresholds: { warningPercent: 80, criticalPercent: 90 },
    volumes: [
      {
        paths: [{ key: 'contents', path: '/srv/ihub/contents' }],
        total: 50 * GiB,
        used: 10 * GiB,
        available: 40 * GiB,
        usedPercent: 20,
        status: 'ok'
      }
    ]
  };
}

/** `GET /api/admin/storage` of an installation that keeps its blobs on local disk. */
function blobStorageStatus(overrides = {}) {
  return {
    blobs: {
      provider: 'filesystem',
      status: 'ok',
      latencyMs: 0,
      checkedAt: '2026-09-30T10:00:00.000Z',
      location: { path: 'contents/data/blobs' },
      encryption: { scope: 'none' },
      source: 'default',
      steps: []
    },
    documents: { provider: 'filesystem' },
    restartRequired: false,
    configuredBlobProvider: 'filesystem',
    localLeftovers: [],
    encryption: { enabled: false, scope: 'none', conversion: { state: 'none' } },
    ...overrides
  };
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  mockFetchStorageStatus.mockReset();
  mockFetchStorageStatus.mockResolvedValue(blobStorageStatus());
});

test('shows each volume with its free space, status and directories', async () => {
  mockMakeAdminApiCall.mockResolvedValue({ data: snapshot() });
  render(<AdminSystemResourcesPage />);

  expect(await screen.findByText('Contents · Data')).toBeInTheDocument();
  expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/system/resources');
  expect(screen.getByText('1.0 GB free of 20.0 GB (95% used)')).toBeInTheDocument();
  expect(screen.getByText('/app/contents/data')).toBeInTheDocument();
  expect(screen.getByText('Critical')).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Contents · Data disk usage' })).toHaveAttribute(
    'aria-valuenow',
    '95'
  );
  expect(screen.getByText(/Disk space is critically low/)).toBeInTheDocument();
});

test('lists every reporting process and flags a missing worker', async () => {
  mockMakeAdminApiCall.mockResolvedValue({ data: snapshot() });
  render(<AdminSystemResourcesPage />);

  const table = await screen.findByRole('table');
  const rows = within(table).getAllByRole('row');
  // header + primary + two workers + one missing worker
  expect(rows).toHaveLength(5);
  expect(within(rows[1]).getByText('Primary')).toBeInTheDocument();
  expect(within(rows[2]).getByText('Worker 0')).toBeInTheDocument();
  expect(within(rows[2]).getByText('served this page')).toBeInTheDocument();
  expect(within(rows[2]).getByText('256 MB')).toBeInTheDocument();
  expect(within(rows[2]).getByText('12.5%')).toBeInTheDocument();
  expect(within(rows[4]).getByText('Worker 2')).toBeInTheDocument();
  expect(within(rows[4]).getByText(/Did not respond/)).toBeInTheDocument();
  expect(screen.getByText('1 of 3 workers did not report back.')).toBeInTheDocument();
});

test('shows host memory with the container limit and CPU limit', async () => {
  mockMakeAdminApiCall.mockResolvedValue({ data: snapshot() });
  render(<AdminSystemResourcesPage />);

  expect(await screen.findByText('6.0 GB of 8.0 GB used')).toBeInTheDocument();
  expect(screen.getByText('Container memory limit (host has 32.0 GB).')).toBeInTheDocument();
  expect(screen.getByText('(limit 2)')).toBeInTheDocument();
});

test('a healthy standalone server shows no alerts', async () => {
  mockMakeAdminApiCall.mockResolvedValue({
    data: snapshot({
      cluster: {
        mode: 'standalone',
        configuredWorkers: 1,
        missingWorkers: [],
        primaryReported: null
      },
      storage: {
        status: 'ok',
        thresholds: { warningPercent: 80, criticalPercent: 90 },
        volumes: [
          {
            paths: [{ key: 'contents', path: '/srv/ihub/contents' }],
            total: 50 * GiB,
            used: 10 * GiB,
            available: 40 * GiB,
            usedPercent: 20,
            status: 'ok'
          }
        ]
      },
      processes: [processEntry({ role: 'standalone', workerIndex: null, current: true })]
    })
  });
  render(<AdminSystemResourcesPage />);

  expect(await screen.findByText('Server')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('reports a load failure', async () => {
  mockMakeAdminApiCall.mockRejectedValue(new Error('Access denied'));
  render(<AdminSystemResourcesPage />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Access denied');
});

test('the auto-refresh never starts a second load while one is still running', async () => {
  jest.useFakeTimers();
  try {
    let answer;
    mockMakeAdminApiCall.mockImplementation(
      () =>
        new Promise(resolve => {
          answer = resolve;
        })
    );
    render(<AdminSystemResourcesPage />);
    expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(1);

    // Two refresh ticks pass while the first request is still out.
    await act(async () => {
      jest.advanceTimersByTime(30000);
    });
    expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer({ data: snapshot() });
    });
    await act(async () => {
      jest.advanceTimersByTime(15000);
    });
    expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

test('shows the blob storage card under disk space, without an alert while it works', async () => {
  mockMakeAdminApiCall.mockResolvedValue({ data: snapshot({ storage: healthyStorage() }) });
  render(<AdminSystemResourcesPage />);

  const heading = await screen.findByRole('heading', { level: 2, name: 'Blob storage' });
  const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
  expect(headings.indexOf('Blob storage')).toBe(headings.indexOf('Disk space') + 1);
  const card = heading.closest('section');
  expect(within(card).getByText('Local disk')).toBeInTheDocument();
  expect(within(card).getByText('contents/data/blobs')).toBeInTheDocument();
  expect(screen.queryByTestId('blob-storage-alert')).not.toBeInTheDocument();
});

test('raises a page alert when the blob storage check failed', async () => {
  mockMakeAdminApiCall.mockResolvedValue({ data: snapshot({ storage: healthyStorage() }) });
  mockFetchStorageStatus.mockResolvedValue(
    blobStorageStatus({
      blobs: {
        provider: 's3',
        status: 'error',
        location: { endpointHost: 's3.example.internal', bucket: 'ihub-blobs' },
        encryption: { scope: 'all' },
        source: 'platform.json',
        error: { code: 'S3_ENDPOINT_UNREACHABLE', detail: 'The endpoint cannot be reached' },
        steps: []
      }
    })
  );
  render(<AdminSystemResourcesPage />);

  const alert = await screen.findByTestId('blob-storage-alert');
  expect(alert).toHaveAttribute('role', 'alert');
  expect(alert).toHaveTextContent('Blob storage is not working');
});

test('keeps the rest of the page when the blob storage status cannot be loaded', async () => {
  mockMakeAdminApiCall.mockResolvedValue({ data: snapshot() });
  mockFetchStorageStatus.mockRejectedValue(new Error('Service unavailable'));
  render(<AdminSystemResourcesPage />);

  expect(await screen.findByText('Contents · Data')).toBeInTheDocument();
  expect(
    await screen.findByText('The blob storage status could not be loaded.')
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.getByRole('table')).toBeInTheDocument();
});
