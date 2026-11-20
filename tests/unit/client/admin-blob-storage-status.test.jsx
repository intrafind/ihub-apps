// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The read-only "Blob storage" card on Admin → System resources
 * (`BlobStorageStatus`): it renders what `GET /api/admin/storage` sends and
 * decides nothing itself. Covered: the local-disk and the S3 state, the
 * encryption line following the scope the server names (never the provider
 * name), the restart and leftover notices, an error with its code and hint,
 * the "Check again" action with its announcements, and that no credential
 * reaches the page.
 *
 * Only the admin API and the translation hook are stubbed.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const mockTestStorage = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  testStorage: (...args) => mockTestStorage(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || ''
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

import BlobStorageStatus from '../../../client/src/features/admin/components/BlobStorageStatus';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

function s3Status(overrides = {}) {
  const { blobs, ...rest } = overrides;
  return {
    blobs: {
      provider: 's3',
      status: 'ok',
      latencyMs: 42,
      checkedAt: '2026-11-19T09:14:03.000Z',
      location: {
        endpointHost: 's3.example.internal:9000',
        bucket: 'ihub-blobs',
        region: 'eu-central-1',
        prefix: 'prod/default/'
      },
      encryption: { scope: 'all', format: 'tink-aes-gcm-hkdf-v1', keySource: 'local-file' },
      source: 'platform.json',
      steps: [
        { name: 'key', status: 'ok', latencyMs: 1 },
        { name: 'connect', status: 'ok', latencyMs: 20 }
      ],
      ...blobs
    },
    documents: { provider: 'filesystem' },
    restartRequired: false,
    configuredBlobProvider: 's3',
    localLeftovers: [],
    encryption: { enabled: true, scope: 'blobs', conversion: { state: 'none' } },
    ...rest
  };
}

function localStatus(overrides = {}) {
  return s3Status({
    blobs: {
      provider: 'filesystem',
      latencyMs: 0,
      location: { path: 'contents/data/blobs' },
      encryption: { scope: 'none' },
      source: 'default',
      steps: []
    },
    configuredBlobProvider: 'filesystem',
    encryption: { enabled: false, scope: 'none', conversion: { state: 'none' } },
    ...overrides
  });
}

beforeEach(() => {
  mockTestStorage.mockReset();
});

test('local disk: shows the path and says plainly that encryption is off', () => {
  render(<BlobStorageStatus status={localStatus()} />);

  expect(screen.getByText('Local disk')).toBeInTheDocument();
  expect(screen.getByText('contents/data/blobs')).toBeInTheDocument();
  expect(screen.getByTestId('blob-storage-status')).toHaveTextContent('Available');
  expect(screen.getByTestId('blob-storage-encryption')).toHaveTextContent(
    'Encryption is switched off.'
  );
  expect(screen.getByText('Default (not set in platform.json)')).toBeInTheDocument();
  expect(screen.queryByText('Endpoint')).not.toBeInTheDocument();
  expect(screen.queryByText('Bucket')).not.toBeInTheDocument();
  expect(screen.queryByTestId('blob-storage-restart')).not.toBeInTheDocument();
  expect(screen.queryByTestId('blob-storage-leftovers')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('S3: shows host, bucket, region, prefix, status and encryption as a definition list', () => {
  const { container } = render(<BlobStorageStatus status={s3Status()} />);

  expect(screen.getByText('S3-compatible object storage')).toBeInTheDocument();
  expect(screen.getByText('s3.example.internal:9000')).toBeInTheDocument();
  expect(screen.getByText('ihub-blobs')).toBeInTheDocument();
  expect(screen.getByText('eu-central-1')).toBeInTheDocument();
  expect(screen.getByText('prod/default/')).toBeInTheDocument();
  expect(screen.getByTestId('blob-storage-status')).toHaveTextContent('Connected');
  expect(screen.getByText(/^Checked .*, 42 ms$/)).toBeInTheDocument();
  expect(screen.getByTestId('blob-storage-encryption')).toHaveTextContent(
    'Every file is encrypted by iHub before it is stored.'
  );
  expect(screen.getByText('Format tink-aes-gcm-hkdf-v1, key from local-file')).toBeInTheDocument();
  expect(screen.getByText('platform.json')).toBeInTheDocument();
  expect(screen.getByText('Chats, logs and locks stay on: Local disk')).toBeInTheDocument();

  const list = container.querySelector('dl');
  expect(list).not.toBeNull();
  expect(list.querySelectorAll('dt').length).toBe(list.querySelectorAll('dd').length);
  // Status is an icon plus text; the icon is hidden from assistive technology.
  expect(screen.getByTestId('blob-storage-status').querySelector('svg')).toHaveAttribute(
    'aria-hidden',
    'true'
  );
});

test('the encryption line follows the scope the server names, not the provider', () => {
  // S3 with encryption switched off (allowed, R3): the card must not say "encrypted".
  const { rerender } = render(
    <BlobStorageStatus
      status={s3Status({
        blobs: { encryption: { scope: 'none' } },
        encryption: { enabled: false, scope: 'none', conversion: { state: 'none' } }
      })}
    />
  );
  expect(screen.getByTestId('blob-storage-encryption')).toHaveTextContent(
    'Encryption is switched off.'
  );

  // Local disk with encryption on: the card must not say "off".
  rerender(
    <BlobStorageStatus
      status={localStatus({
        encryption: { enabled: true, scope: 'blobs', conversion: { state: 'none' } }
      })}
    />
  );
  expect(screen.getByTestId('blob-storage-encryption')).toHaveTextContent(
    'Every file is encrypted by iHub before it is stored.'
  );

  rerender(
    <BlobStorageStatus
      status={localStatus({
        encryption: { enabled: true, scope: 'storage', conversion: { state: 'complete' } }
      })}
    />
  );
  expect(screen.getByTestId('blob-storage-encryption')).toHaveTextContent(
    'Everything iHub stores is encrypted'
  );

  expect(screen.queryByTestId('blob-storage-converting')).not.toBeInTheDocument();

  // While existing data is still being converted, the card says so.
  rerender(
    <BlobStorageStatus
      status={localStatus({
        encryption: { enabled: true, scope: 'storage', conversion: { state: 'converting' } }
      })}
    />
  );
  expect(screen.getByTestId('blob-storage-converting')).toHaveTextContent(
    'is still being encrypted'
  );

  // A scope this client has no sentence for is shown as sent.
  rerender(
    <BlobStorageStatus
      status={localStatus({ encryption: { enabled: true, scope: 'documents-only' } })}
    />
  );
  expect(screen.getByTestId('blob-storage-encryption')).toHaveTextContent('documents-only');
});

test('a provider the client does not know is shown as sent', () => {
  render(<BlobStorageStatus status={s3Status({ blobs: { provider: 'azure-blob' } })} />);
  expect(screen.getByText('azure-blob')).toBeInTheDocument();
});

test('shows the restart notice with the saved and the running backend', () => {
  render(
    <BlobStorageStatus
      status={localStatus({ restartRequired: true, configuredBlobProvider: 's3' })}
    />
  );
  const notice = screen.getByTestId('blob-storage-restart');
  expect(notice).toHaveTextContent('Restart the server to apply them.');
  expect(notice).toHaveTextContent('Saved: S3-compatible object storage. Running: Local disk.');
});

test('names the files left on local disk, per namespace, and the command that copies them', () => {
  render(
    <BlobStorageStatus
      status={s3Status({
        localLeftovers: [
          { namespace: 'chat-files', count: 12, capped: false },
          { namespace: 'artifacts', count: 3, capped: false }
        ]
      })}
    />
  );
  const notice = screen.getByTestId('blob-storage-leftovers');
  expect(notice).toHaveTextContent('15 files from before the switch are still on local disk.');
  expect(notice).toHaveTextContent('npm run storage:copy-blobs');
  expect(within(notice).getByText('chat-files')).toBeInTheDocument();
  expect(notice).toHaveTextContent('artifacts: 3');
});

test('says "at least" when a count was capped', () => {
  render(
    <BlobStorageStatus
      status={s3Status({
        localLeftovers: [{ namespace: 'chat-files', count: 1000, capped: true }]
      })}
    />
  );
  expect(screen.getByTestId('blob-storage-leftovers')).toHaveTextContent(
    'At least 1000 files from before the switch'
  );
});

test('an error shows the sentence, the hint and the code', () => {
  render(
    <BlobStorageStatus
      status={s3Status({
        blobs: {
          status: 'error',
          error: {
            code: 'S3_CREDENTIALS_REJECTED',
            detail: 'The S3 service rejected the access key',
            step: 'connect',
            hint: 'Check the access key ID and the secret key.'
          },
          steps: [
            { name: 'key', status: 'ok', latencyMs: 1 },
            { name: 'connect', status: 'failed', latencyMs: 9, code: 'S3_CREDENTIALS_REJECTED' }
          ]
        }
      })}
    />
  );
  expect(screen.getByTestId('blob-storage-status')).toHaveTextContent('Access refused');
  const error = screen.getByTestId('blob-storage-error');
  expect(error).toHaveTextContent('The S3 service rejected the access key');
  expect(error).toHaveTextContent('Check the access key ID and the secret key.');
  expect(within(error).getByText('S3_CREDENTIALS_REJECTED')).toBeInTheDocument();
  expect(within(error).getByText('Details').tagName).toBe('SUMMARY');
});

test.each([
  ['S3_ENDPOINT_UNREACHABLE', 'Not reachable'],
  ['S3_ACCESS_DENIED', 'Access refused'],
  ['BLOB_KEY_MISMATCH', 'Check failed']
])('error %s is labelled "%s"', (code, label) => {
  render(
    <BlobStorageStatus
      status={s3Status({ blobs: { status: 'error', error: { code, detail: 'x' } } })}
    />
  );
  expect(screen.getByTestId('blob-storage-status')).toHaveTextContent(label);
});

test('a status the client does not know, and one not checked yet, read "Not checked yet"', () => {
  const { rerender } = render(
    <BlobStorageStatus status={s3Status({ blobs: { status: 'unknown', checkedAt: undefined } })} />
  );
  expect(screen.getByTestId('blob-storage-status')).toHaveTextContent('Not checked yet');
  rerender(<BlobStorageStatus status={s3Status({ blobs: { status: 'starting' } })} />);
  expect(screen.getByTestId('blob-storage-status')).toHaveTextContent('Not checked yet');
});

test('"Check again" announces the result, hands the status on and keeps the focus', async () => {
  let resolve;
  mockTestStorage.mockReturnValue(new Promise(r => (resolve = r)));
  const onStatus = jest.fn();
  render(<BlobStorageStatus status={s3Status()} onStatus={onStatus} />);

  const result = screen.getByTestId('blob-storage-result');
  expect(result).toHaveAttribute('role', 'status');
  expect(result).toBeEmptyDOMElement();

  const button = screen.getByRole('button', { name: 'Check again' });
  button.focus();
  fireEvent.click(button);

  const busy = screen.getByRole('button', { name: 'Checking…' });
  expect(busy).toHaveAttribute('aria-disabled', 'true');
  expect(busy).not.toBeDisabled();
  expect(busy).toHaveFocus();
  // A second click while the check runs starts nothing.
  fireEvent.click(busy);
  expect(mockTestStorage).toHaveBeenCalledTimes(1);

  const next = s3Status({ blobs: { latencyMs: 61 } });
  await act(async () => resolve(next));

  expect(onStatus).toHaveBeenCalledWith(next);
  expect(screen.getByTestId('blob-storage-result')).toHaveTextContent(
    'Check passed: a test object was written, read back and removed in 61 ms.'
  );
  expect(screen.getByRole('button', { name: 'Check again' })).toHaveFocus();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a failed check is announced as an alert with its cause', async () => {
  const failed = s3Status({
    blobs: {
      status: 'error',
      error: { code: 'S3_BUCKET_NOT_FOUND', detail: 'The bucket does not exist', step: 'connect' }
    }
  });
  mockTestStorage.mockResolvedValue(failed);
  const onStatus = jest.fn();
  render(<BlobStorageStatus status={s3Status()} onStatus={onStatus} />);

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check again' })));

  expect(screen.getByRole('alert')).toHaveTextContent('Check failed: The bucket does not exist');
  expect(onStatus).toHaveBeenCalledWith(failed);
});

test('a check that could not run shows the problem detail', async () => {
  mockTestStorage.mockRejectedValue({
    response: { data: { detail: 'The storage provider is not running' } }
  });
  render(<BlobStorageStatus status={s3Status()} />);

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check again' })));

  expect(screen.getByRole('alert')).toHaveTextContent(
    'The check could not run: The storage provider is not running'
  );
});

test('a status that could not be loaded offers "Try again"', () => {
  const onRetry = jest.fn();
  render(<BlobStorageStatus status={null} loadFailed onRetry={onRetry} />);

  expect(screen.getByRole('alert')).toHaveTextContent(
    'The blob storage status could not be loaded.'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('renders nothing before the first status has arrived', () => {
  const { container } = render(<BlobStorageStatus status={null} />);
  expect(container).toBeEmptyDOMElement();
});

test('no credential reaches the page, whatever the server sends beside the known fields', () => {
  const { container } = render(
    <BlobStorageStatus
      status={s3Status({
        blobs: {
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'super-secret',
          location: {
            endpointHost: 's3.example.internal',
            bucket: 'ihub-blobs',
            endpoint: 'https://key:secret@s3.example.internal'
          }
        }
      })}
    />
  );
  expect(container.textContent).not.toMatch(/AKIDEXAMPLE|super-secret|key:secret|REDACTED/);
  expect(container.textContent).not.toMatch(/https?:\/\//);
});

test('English and German have the same keys, and the wording is "Blob storage"', () => {
  const keysOf = (node, prefix = '') =>
    Object.entries(node).flatMap(([key, value]) =>
      value && typeof value === 'object' ? keysOf(value, `${prefix}${key}.`) : [`${prefix}${key}`]
    );
  const english = en.admin.systemResources.blobStorage;
  const german = de.admin.systemResources.blobStorage;
  expect(keysOf(german).sort()).toEqual(keysOf(english).sort());
  expect(english.title).toBe('Blob storage');
  expect(german.title).toBe('Blob-Speicher');
  expect(en.admin.backup.sensitivity.blobStorage).toMatch(/not part of this export/);
  expect(de.admin.backup.sensitivity.blobStorage).toMatch(/nicht Teil dieses Exports/);
});
