// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  LockOpenIcon,
  QuestionMarkCircleIcon,
  XCircleIcon
} from '@heroicons/react/24/outline';
import {
  STORAGE_TEST_TIMEOUT_MS,
  getAdminApiErrorMessage,
  testStorage
} from '../../../api/adminApi';
import { BLOB_STATUS_STYLES } from '../utils/systemResourcesFormat';
import { CALLOUT_CLASS, SECONDARY_BUTTON_CLASS } from './formStyles';

/**
 * Body of the read-only "Blob storage" card on Admin → System resources.
 *
 * It renders what `GET /api/admin/storage` sends: which backend holds the
 * blobs, whether it answers, how the content is encrypted, where the setting
 * comes from, whether a restart is due and whether files are left on local
 * disk. Every fact is decided by the server; nothing is inferred from a
 * provider name here. A value the client has no label for is shown as sent.
 *
 * One action: "Check again" (`POST /api/admin/storage/_test`). Its result is
 * announced in a live region and handed to the page through `onStatus`.
 *
 * Language: the server writes its sentences in English. The card translates
 * what it can by the code the server sends (`errors.<code>`, `hints.<code>`,
 * `stepStatus.<status>`); whatever is still shown as sent is marked
 * `lang="en"`, so a screen reader pronounces it correctly on a German page
 * (WCAG 3.1.2).
 *
 * @param {Object} props
 * @param {Object|null} props.status - The response of `GET /api/admin/storage`.
 * @param {boolean} [props.loadFailed] - The status could not be loaded.
 * @param {() => void} [props.onRetry] - Load the status again.
 * @param {(status: Object) => void} [props.onStatus] - Receives the status a check returned.
 */

/** Error codes that mean "the credentials were not accepted". */
const REFUSED_CODES = new Set(['S3_CREDENTIALS_REJECTED', 'S3_ACCESS_DENIED']);
/** Error codes that mean "the backend did not answer". */
const UNREACHABLE_CODES = new Set([
  'S3_ENDPOINT_UNREACHABLE',
  'S3_TLS_UNTRUSTED',
  'S3_BUCKET_NOT_FOUND',
  'S3_SERVICE_ERROR'
]);

const STATUS_ICONS = {
  ok: CheckCircleIcon,
  degraded: ExclamationTriangleIcon,
  error: XCircleIcon,
  unknown: QuestionMarkCircleIcon
};

const DT_CLASS = 'text-sm text-gray-600 dark:text-gray-400';
const DD_CLASS = 'text-sm text-gray-900 dark:text-gray-100 min-w-0';
const MONO_CLASS = 'font-mono break-all';
const NOTICE_CLASS =
  'mb-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg flex';

/** The two documented ways to start the copy command; see docs/storage.md. */
const COPY_COMMAND_NPM = 'npm run storage:copy-blobs';
const COPY_COMMAND_NODE = 'node server/storage/commands/run.js copy-blobs';

/** Text the server sent in English, marked as such for assistive technology. */
function ServerText({ children }) {
  return <span lang="en">{children}</span>;
}

/**
 * The sentence for a failure: translated by its code when the client has a
 * translation, otherwise the server's own sentence, marked as English.
 *
 * @param {Object} props
 * @param {(key: string, fallback?: string, options?: Object) => string} props.t
 * @param {string} [props.code] - A code of the server's check.
 * @param {string} [props.detail] - The server's sentence.
 */
function ErrorSentence({ t, code, detail }) {
  const translated = code ? t(`admin.systemResources.blobStorage.errors.${code}`, '') : '';
  if (translated) return translated;
  return detail ? <ServerText>{detail}</ServerText> : null;
}

/** Whether the client has its own sentence for a failure code. */
function hasErrorSentence(t, code) {
  return Boolean(code && t(`admin.systemResources.blobStorage.errors.${code}`, ''));
}

function Row({ label, children }) {
  return (
    <>
      <dt className={DT_CLASS}>{label}</dt>
      <dd className={DD_CLASS}>{children}</dd>
    </>
  );
}

function Notice({ testId, children }) {
  return (
    <div className={NOTICE_CLASS} data-testid={testId}>
      <ExclamationTriangleIcon
        className="w-5 h-5 text-yellow-700 dark:text-yellow-400 mt-0.5 mr-3 shrink-0"
        aria-hidden="true"
      />
      <div className="text-sm text-yellow-800 dark:text-yellow-300">{children}</div>
    </div>
  );
}

function BlobStorageStatus({ status, loadFailed = false, onRetry, onStatus }) {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  // The last manual check: { type: 'success', ms }, { type: 'failed', code,
  // detail }, { type: 'timeout' } or { type: 'notRun', detail }.
  const [result, setResult] = useState(null);

  const runTest = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setResult(null);
    try {
      const next = await testStorage();
      onStatus?.(next);
      const blobs = next?.blobs || {};
      if (blobs.status === 'ok') {
        setResult({ type: 'success', ms: blobs.latencyMs ?? 0 });
      } else {
        setResult({
          type: 'failed',
          code: blobs.error?.code,
          detail: blobs.error?.detail || blobs.status || ''
        });
      }
    } catch (err) {
      // The browser gave up waiting (axios: ECONNABORTED). The server goes on
      // with the check and holds its result; the page's next poll shows it.
      if (err?.code === 'ECONNABORTED' && !err?.response) {
        setResult({ type: 'timeout' });
        onRetry?.();
      } else {
        setResult({ type: 'notRun', detail: getAdminApiErrorMessage(err) });
      }
    } finally {
      setTesting(false);
    }
  }, [onRetry, onStatus, testing]);

  if (!status?.blobs) {
    if (!loadFailed) return null;
    return (
      <div role="alert" className={CALLOUT_CLASS.danger}>
        <p>
          {t(
            'admin.systemResources.blobStorage.loadFailed',
            'The blob storage status could not be loaded.'
          )}
        </p>
        {onRetry && (
          <button type="button" onClick={onRetry} className={`${SECONDARY_BUTTON_CLASS} mt-3`}>
            {t('admin.systemResources.blobStorage.retry', 'Try again')}
          </button>
        )}
      </div>
    );
  }

  const { blobs, documents, restartRequired, configuredBlobProvider } = status;
  const location = blobs.location || {};
  const isLocal = typeof location.path === 'string';
  const state = Object.hasOwn(BLOB_STATUS_STYLES, blobs.status) ? blobs.status : 'unknown';
  const StatusIcon = STATUS_ICONS[state];
  const errorCode = blobs.error?.code;

  const backendLabels = {
    s3: t('admin.systemResources.blobStorage.backend.s3', 'S3-compatible object storage'),
    filesystem: t('admin.systemResources.blobStorage.backend.filesystem', 'Local disk')
  };
  const backendLabel = name => (Object.hasOwn(backendLabels, name) ? backendLabels[name] : name);

  let statusLabel;
  if (state === 'ok') {
    statusLabel = isLocal
      ? t('admin.systemResources.blobStorage.status.available', 'Available')
      : t('admin.systemResources.blobStorage.status.ok', 'Connected');
  } else if (state === 'degraded') {
    statusLabel = t('admin.systemResources.blobStorage.status.degraded', 'Slow or partly failing');
  } else if (state === 'unknown') {
    statusLabel = t('admin.systemResources.blobStorage.status.unknown', 'Not checked yet');
  } else if (REFUSED_CODES.has(errorCode)) {
    statusLabel = t('admin.systemResources.blobStorage.status.refused', 'Access refused');
  } else if (UNREACHABLE_CODES.has(errorCode)) {
    statusLabel = t('admin.systemResources.blobStorage.status.unreachable', 'Not reachable');
  } else {
    statusLabel = t('admin.systemResources.blobStorage.status.failed', 'Check failed');
  }

  // The server names the scope; `blobs.encryption.scope` ("all") is the same
  // statement for the blobs alone and is only read when the first is missing.
  const scope = status.encryption?.scope || (blobs.encryption?.scope === 'all' ? 'blobs' : 'none');
  const encryptionRows = {
    storage: {
      Icon: LockClosedIcon,
      tone: 'text-green-700 dark:text-green-400',
      text: t(
        'admin.systemResources.blobStorage.encryption.storage',
        'Everything iHub stores is encrypted before it is written: files, chats and logs.'
      )
    },
    blobs: {
      Icon: LockClosedIcon,
      tone: 'text-green-700 dark:text-green-400',
      text: t(
        'admin.systemResources.blobStorage.encryption.blobs',
        'Every file is encrypted by iHub before it is stored.'
      )
    },
    none: {
      Icon: LockOpenIcon,
      tone: 'text-amber-700 dark:text-amber-400',
      text: t(
        'admin.systemResources.blobStorage.encryption.none',
        'Encryption is switched off. Files are stored as they are: whoever can read the storage can read them.'
      )
    }
  };
  const encryption = Object.hasOwn(encryptionRows, scope)
    ? encryptionRows[scope]
    : { Icon: QuestionMarkCircleIcon, tone: 'text-gray-600 dark:text-gray-400', text: scope };

  const sourceLabels = {
    'platform.json': 'platform.json',
    environment: t(
      'admin.systemResources.blobStorage.source.environment',
      'Environment variable IHUB_STORAGE_BLOBS_PROVIDER'
    ),
    default: t(
      'admin.systemResources.blobStorage.source.default',
      'Default (not set in platform.json)'
    )
  };

  const leftovers = Array.isArray(status.localLeftovers) ? status.localLeftovers : [];
  const leftoverCount = leftovers.reduce((sum, entry) => sum + (entry.count || 0), 0);
  const leftoverCapped = leftovers.some(entry => entry.capped);

  // The saved and the running backend are only worth naming when they differ.
  // The server also asks for a restart when the backend stays the same and one
  // of its settings changed; "Saved: X. Running: X." would explain nothing.
  const backendChanged =
    typeof configuredBlobProvider === 'string' && configuredBlobProvider !== blobs.provider;

  const stepStatusLabels = {
    ok: t('admin.systemResources.blobStorage.stepStatus.ok', 'passed'),
    failed: t('admin.systemResources.blobStorage.stepStatus.failed', 'failed'),
    skipped: t('admin.systemResources.blobStorage.stepStatus.skipped', 'skipped')
  };
  const translatedHint = errorCode
    ? t(`admin.systemResources.blobStorage.hints.${errorCode}`, '')
    : '';

  const checkedTime = blobs.checkedAt ? new Date(blobs.checkedAt) : null;

  return (
    <div aria-busy={testing ? 'true' : 'false'}>
      {restartRequired && (
        <Notice testId="blob-storage-restart">
          <p>
            {t(
              'admin.systemResources.blobStorage.restartRequired',
              'The saved blob storage settings differ from the ones the server is running with. Restart the server to apply them.'
            )}
          </p>
          <p className="mt-1" data-testid="blob-storage-restart-detail">
            {backendChanged
              ? t(
                  'admin.systemResources.blobStorage.restartDetail',
                  'Saved: {{configured}}. Running: {{running}}.',
                  {
                    configured: backendLabel(configuredBlobProvider),
                    running: backendLabel(blobs.provider)
                  }
                )
              : t(
                  'admin.systemResources.blobStorage.restartSameBackend',
                  'The backend stays the same; one of its saved settings differs: endpoint, bucket, prefix, region, size limit or encryption.'
                )}
          </p>
        </Notice>
      )}

      {leftoverCount > 0 && (
        <Notice testId="blob-storage-leftovers">
          <p>
            {leftoverCapped
              ? t('admin.systemResources.blobStorage.leftoversAtLeast', {
                  count: leftoverCount,
                  defaultValue_one:
                    'At least {{count}} file from before the switch is still on local disk. Users cannot open it until it is copied to the bucket.',
                  defaultValue_other:
                    'At least {{count}} files from before the switch are still on local disk. Users cannot open them until they are copied to the bucket.'
                })
              : t('admin.systemResources.blobStorage.leftovers', {
                  count: leftoverCount,
                  defaultValue_one:
                    '{{count}} file from before the switch is still on local disk. Users cannot open it until it is copied to the bucket.',
                  defaultValue_other:
                    '{{count}} files from before the switch are still on local disk. Users cannot open them until they are copied to the bucket.'
                })}
          </p>
          {/* Both documented forms: the card cannot know how iHub was installed. */}
          <p className="mt-1">
            {t(
              'admin.systemResources.blobStorage.leftoversHint',
              'Copy them while the server is stopped:'
            )}{' '}
            <code className={MONO_CLASS}>{COPY_COMMAND_NPM}</code>
          </p>
          <p className="mt-1">
            {t(
              'admin.systemResources.blobStorage.leftoversHintContainer',
              'In the container image, where npm is not installed:'
            )}{' '}
            <code className={MONO_CLASS}>{COPY_COMMAND_NODE}</code>
          </p>
          <ul className="mt-1 list-disc list-inside">
            {leftovers.map(entry => (
              <li key={entry.namespace}>
                <span className={MONO_CLASS}>{entry.namespace}</span>: {entry.count}
                {entry.capped ? '+' : ''}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-x-4 gap-y-2">
        <Row label={t('admin.systemResources.blobStorage.statusLabel', 'Status')}>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${BLOB_STATUS_STYLES[state]}`}
            data-testid="blob-storage-status"
          >
            <StatusIcon className="w-4 h-4" aria-hidden="true" />
            {statusLabel}
          </span>
          {checkedTime && (
            <span className="ml-2 text-xs text-gray-600 dark:text-gray-400">
              {t('admin.systemResources.blobStorage.checked', 'Checked {{when}}, {{ms}} ms', {
                when: checkedTime.toLocaleTimeString(),
                ms: blobs.latencyMs ?? 0
              })}
            </span>
          )}
        </Row>
        <Row label={t('admin.systemResources.blobStorage.backendLabel', 'Backend')}>
          {backendLabel(blobs.provider)}
        </Row>
        {location.endpointHost && (
          <Row label={t('admin.systemResources.blobStorage.endpoint', 'Endpoint')}>
            <span className={MONO_CLASS}>{location.endpointHost}</span>
          </Row>
        )}
        {location.bucket && (
          <Row label={t('admin.systemResources.blobStorage.bucket', 'Bucket')}>
            <span className={MONO_CLASS}>{location.bucket}</span>
          </Row>
        )}
        {location.region && (
          <Row label={t('admin.systemResources.blobStorage.region', 'Region')}>
            <span className={MONO_CLASS}>{location.region}</span>
          </Row>
        )}
        {location.prefix && (
          <Row label={t('admin.systemResources.blobStorage.prefix', 'Prefix')}>
            <span className={MONO_CLASS}>{location.prefix}</span>
          </Row>
        )}
        {isLocal && (
          <Row label={t('admin.systemResources.blobStorage.path', 'Path')}>
            <span className={MONO_CLASS}>{location.path}</span>
          </Row>
        )}
        <Row label={t('admin.systemResources.blobStorage.encryptionLabel', 'Encryption')}>
          <span className="flex items-start gap-1.5" data-testid="blob-storage-encryption">
            <encryption.Icon
              className={`w-4 h-4 mt-0.5 shrink-0 ${encryption.tone}`}
              aria-hidden="true"
            />
            <span>{encryption.text}</span>
          </span>
          {status.encryption?.conversion?.state === 'converting' && (
            <span
              className="block mt-0.5 text-xs text-amber-700 dark:text-amber-400"
              data-testid="blob-storage-converting"
            >
              {t(
                'admin.systemResources.blobStorage.encryption.converting',
                'Data stored before encryption was switched on is still being encrypted.'
              )}
            </span>
          )}
          {blobs.encryption?.format && (
            <span className="block mt-0.5 text-xs text-gray-600 dark:text-gray-400">
              {t(
                'admin.systemResources.blobStorage.encryptionDetail',
                'Format {{format}}, key from {{keySource}}',
                { format: blobs.encryption.format, keySource: blobs.encryption.keySource || '?' }
              )}
            </span>
          )}
        </Row>
        {blobs.source && (
          <Row label={t('admin.systemResources.blobStorage.configuredIn', 'Configured in')}>
            {Object.hasOwn(sourceLabels, blobs.source) ? sourceLabels[blobs.source] : blobs.source}
          </Row>
        )}
        {documents?.provider && (
          <Row label={t('admin.systemResources.blobStorage.otherData', 'Other data')}>
            {t(
              'admin.systemResources.blobStorage.otherDataValue',
              'Chats, logs and locks stay on: {{provider}}',
              { provider: backendLabel(documents.provider) }
            )}
          </Row>
        )}
      </dl>

      {blobs.error && (
        <div className={`${CALLOUT_CLASS.danger} mt-4`} data-testid="blob-storage-error">
          <p>
            <ErrorSentence t={t} code={errorCode} detail={blobs.error.detail} />
          </p>
          <p className="mt-1">
            {translatedHint ||
              (blobs.error.hint ? <ServerText>{blobs.error.hint}</ServerText> : null)}
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer">
              {t('admin.systemResources.blobStorage.details', 'Details')}
            </summary>
            <p className="mt-1">
              <span className={MONO_CLASS}>{blobs.error.code}</span>
            </p>
            {/* The server's own sentence, when the line above shows a translation. */}
            {hasErrorSentence(t, errorCode) && blobs.error.detail && (
              <p className="mt-1" data-testid="blob-storage-error-detail">
                <ServerText>{blobs.error.detail}</ServerText>
              </p>
            )}
            {Array.isArray(blobs.steps) && blobs.steps.length > 0 && (
              <ul className="mt-1 list-disc list-inside">
                {blobs.steps.map(step => (
                  <li key={step.name}>
                    <span className={MONO_CLASS}>{step.name}</span>:{' '}
                    {Object.hasOwn(stepStatusLabels, step.status) ? (
                      stepStatusLabels[step.status]
                    ) : (
                      <ServerText>{step.status}</ServerText>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      )}

      <p className="mt-4 text-xs text-gray-600 dark:text-gray-400">
        {t(
          'admin.systemResources.blobStorage.readOnly',
          'These settings are read from platform.json. Changing them needs a restart.'
        )}
      </p>

      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runTest}
          aria-disabled={testing ? 'true' : 'false'}
          className={`${SECONDARY_BUTTON_CLASS} ${testing ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          <ArrowPathIcon
            className={`w-4 h-4 ${testing ? 'motion-safe:animate-spin' : ''}`}
            aria-hidden="true"
          />
          {testing
            ? t('admin.systemResources.blobStorage.checking', 'Checking…')
            : t('admin.systemResources.blobStorage.checkAgain', 'Check again')}
        </button>
      </div>
      {/* Mounted empty from the start, so a passed check is announced. */}
      <div
        role="status"
        data-testid="blob-storage-result"
        className="mt-2 text-sm text-green-700 dark:text-green-400"
      >
        {result?.type === 'success'
          ? t(
              'admin.systemResources.blobStorage.testPassed',
              'Check passed: a test object was written, read back and removed in {{ms}} ms.',
              { ms: result.ms }
            )
          : ''}
      </div>
      {/* An alert is announced when it is added, so it only exists with a failure. */}
      {result && result.type !== 'success' && (
        <div
          role="alert"
          data-testid="blob-storage-result-error"
          className="text-sm text-red-700 dark:text-red-300"
        >
          {result.type === 'failed' && (
            <>
              {t('admin.systemResources.blobStorage.testFailed', 'Check failed:')}{' '}
              <ErrorSentence t={t} code={result.code} detail={result.detail} />
            </>
          )}
          {result.type === 'timeout' &&
            t(
              'admin.systemResources.blobStorage.testTimedOut',
              'The storage has not answered within {{seconds}} seconds. The server continues the check; this card shows the result as soon as there is one.',
              { seconds: Math.round(STORAGE_TEST_TIMEOUT_MS / 1000) }
            )}
          {result.type === 'notRun' && (
            <>
              {t('admin.systemResources.blobStorage.testNotRun', 'The check could not run:')}{' '}
              <ServerText>{result.detail}</ServerText>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default BlobStorageStatus;
