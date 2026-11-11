// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../../shared/components/ConfirmDialog';
import Badge from '../../../../shared/components/Badge';
import Icon from '../../../../shared/components/Icon';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import {
  createWatermarkKey,
  deleteWatermarkKey,
  fetchWatermarkDetectors,
  fetchWatermarkKeys,
  revealWatermarkKey
} from '../../../../api/euAiActAdminApi';
import AdminLoadError from '../AdminLoadError';
import DetectorRows from './DetectorRows';
import EuAiActCard from './EuAiActCard';
import { AddKeyDialog, BUTTON_PRIMARY, BUTTON_SECONDARY, KeyShownDialog } from './KeyDialogs';

function formatDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : '-';
}

/**
 * Card 3: the watermark keys (list, generate, add, reveal, delete retired) and
 * the detector of each model marked "iHub" with its test and self-test.
 *
 * Keys come back as decimal strings and live only in the open dialog's state.
 */
export default function WatermarkKeysCard({ statusModels, onChanged }) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState(null);
  const [detectors, setDetectors] = useState([]);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [shown, setShown] = useState(null);
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const captionRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [keyList, detectorList] = await Promise.all([
        fetchWatermarkKeys(),
        fetchWatermarkDetectors()
      ]);
      setKeys(keyList.items || []);
      setDetectors(detectorList.items || []);
      setError(null);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  const active = keys?.find(key => key.status === 'active');
  const sorted = keys
    ? [...keys].sort(
        (a, b) =>
          (b.status === 'active') - (a.status === 'active') ||
          String(b.createdAt).localeCompare(String(a.createdAt))
      )
    : [];

  const showCreated = (result, previous) => {
    setShown({
      keyId: result.keyId,
      key: result.key,
      vllmConfigSnippet: result.vllmConfigSnippet,
      weakKey: result.weakKey,
      generated: true
    });
    setMessage(
      previous
        ? t('admin.euAiAct.keys.nowActive', 'Key {{id}} is now active. {{old}} is retired.', {
            id: result.keyId,
            old: previous
          })
        : t('admin.euAiAct.keys.nowActiveFirst', 'Key {{id}} is now active.', {
            id: result.keyId
          })
    );
  };

  const generate = async () => {
    setConfirmGenerate(false);
    setBusy(true);
    try {
      const result = await createWatermarkKey();
      showCreated(result, active?.keyId);
      await changed();
    } catch (err) {
      setMessage(getAdminApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startGenerate = () => (active ? setConfirmGenerate(true) : generate());

  const addKey = async ({ key, label }) => {
    const result = await createWatermarkKey({ key, label });
    setAddOpen(false);
    showCreated(result, active?.keyId);
    await changed();
  };

  const reveal = async keyId => {
    try {
      const result = await revealWatermarkKey(keyId);
      setShown({
        keyId: result.keyId,
        key: result.key,
        vllmConfigSnippet: result.vllmConfigSnippet,
        generated: false
      });
      setMessage(
        t('admin.euAiAct.keys.revealed', 'Key shown. This was recorded in the audit log.')
      );
    } catch (err) {
      setMessage(getAdminApiErrorMessage(err));
    }
  };

  const confirmDelete = async () => {
    const keyId = deleting;
    setDeleting(null);
    try {
      await deleteWatermarkKey(keyId);
      setMessage(t('admin.euAiAct.keys.deleted', 'Key {{id}} deleted.', { id: keyId }));
    } catch (err) {
      // A stale list ("already deleted") only needs a refresh.
      setMessage(getAdminApiErrorMessage(err));
    }
    await changed();
    captionRef.current?.focus();
  };

  const hideSecret = useCallback(
    () =>
      setShown(current => (current ? { ...current, key: null, vllmConfigSnippet: null } : current)),
    []
  );
  const closeShown = useCallback(() => setShown(null), []);

  const headerActions = (
    <>
      <button type="button" onClick={startGenerate} disabled={busy} className={BUTTON_PRIMARY}>
        <Icon name="key" size="sm" />
        {t('admin.euAiAct.keys.generate', 'Generate key')}
      </button>
      <button type="button" onClick={() => setAddOpen(true)} className={BUTTON_SECONDARY}>
        {t('admin.euAiAct.keys.add', 'Add own key…')}
      </button>
    </>
  );

  return (
    <EuAiActCard
      id="watermark-keys"
      title={t('admin.euAiAct.keys.title', 'Watermark keys')}
      description={t(
        'admin.euAiAct.keys.description',
        'Keys for the iHub text watermark of vLLM models. Exactly one key is active; retired keys are used for detection only. Showing a key is recorded in the audit log.'
      )}
      actions={headerActions}
    >
      {error && !keys ? (
        <AdminLoadError
          framed={false}
          message={error}
          title={t('admin.euAiAct.keys.loadError', 'Could not load the keys')}
          action={{ label: t('common.retry', 'Retry'), onClick: load }}
        />
      ) : (
        <div className="space-y-6">
          {keys && keys.length === 0 ? (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t(
                'admin.euAiAct.keys.empty',
                'No watermark key yet. Keys are only needed for models marked "iHub watermark".'
              )}
            </p>
          ) : (
            keys && (
              <div
                className="overflow-x-auto"
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable
                tabIndex={0}
                role="region"
                aria-label={t('admin.euAiAct.keys.tableRegion', 'Watermark keys table')}
              >
                <table className="min-w-full text-sm">
                  <caption
                    ref={captionRef}
                    tabIndex={-1}
                    className="sr-only focus:not-sr-only focus:text-left focus:mb-2"
                  >
                    {t('admin.euAiAct.keys.caption', 'Watermark keys')}
                  </caption>
                  <thead>
                    <tr className="text-left text-xs uppercase text-gray-600 dark:text-gray-400">
                      <th scope="col" className="py-2 pr-4 font-medium">
                        {t('admin.euAiAct.keys.colId', 'Key ID')}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        {t('admin.euAiAct.keys.colCreated', 'Created')}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        {t('admin.euAiAct.keys.colStatus', 'Status')}
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        {t('admin.euAiAct.keys.colActions', 'Actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {sorted.map(item => (
                      <tr key={item.keyId}>
                        <th
                          scope="row"
                          className="py-3 pr-4 font-mono text-xs text-gray-900 dark:text-gray-100 text-left"
                        >
                          {item.keyId}
                          {item.label && (
                            <span className="block font-sans font-normal text-gray-600 dark:text-gray-400">
                              {item.label}
                            </span>
                          )}
                        </th>
                        <td className="py-3 pr-4 text-gray-700 dark:text-gray-300">
                          {formatDate(item.createdAt)}
                        </td>
                        <td className="py-3 pr-4">
                          {item.status === 'active' ? (
                            <Badge tone="success" icon={<Icon name="check-circle" size="sm" />}>
                              {t('admin.euAiAct.keys.active', 'Active')}
                            </Badge>
                          ) : (
                            <Badge tone="neutral" icon={<Icon name="clock" size="sm" />}>
                              {t('admin.euAiAct.keys.retired', 'Retired (detection only)')}
                            </Badge>
                          )}
                        </td>
                        <td className="py-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => reveal(item.keyId)}
                              aria-label={t('admin.euAiAct.keys.revealAria', 'Reveal key {{id}}', {
                                id: item.keyId
                              })}
                              className={BUTTON_SECONDARY}
                            >
                              <Icon name="eye" size="sm" />
                              {t('admin.euAiAct.keys.reveal', 'Reveal')}
                            </button>
                            {item.status === 'retired' && (
                              <button
                                type="button"
                                onClick={() => setDeleting(item.keyId)}
                                aria-label={t(
                                  'admin.euAiAct.keys.deleteAria',
                                  'Delete key {{id}}',
                                  {
                                    id: item.keyId
                                  }
                                )}
                                className={`${BUTTON_SECONDARY} text-red-700 dark:text-red-300`}
                              >
                                <Icon name="trash" size="sm" />
                                {t('admin.euAiAct.keys.delete', 'Delete')}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                  {t(
                    'admin.euAiAct.keys.deleteNote',
                    'Retired keys can be deleted. The active key cannot.'
                  )}
                </p>
              </div>
            )
          )}
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {t(
              'admin.euAiAct.keys.backup',
              'Keys are stored encrypted with contents/.encryption-key. Back that file up: without it the stored keys cannot be read.'
            )}
          </p>
          <div role="status" aria-live="polite">
            {message && <p className="text-sm text-gray-900 dark:text-gray-100">{message}</p>}
          </div>
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
              {t('admin.euAiAct.detector.title', 'Detectors and self-test')}
            </h3>
            <DetectorRows detectors={detectors} statusModels={statusModels} onChanged={onChanged} />
          </div>
        </div>
      )}

      <KeyShownDialog
        shown={shown}
        onClose={closeShown}
        onHide={hideSecret}
        onRevealAgain={() => shown && reveal(shown.keyId)}
      />
      <AddKeyDialog isOpen={addOpen} onClose={() => setAddOpen(false)} onSubmit={addKey} />
      <ConfirmDialog
        isOpen={confirmGenerate}
        title={t('admin.euAiAct.keys.generateTitle', 'Generate a new key?')}
        message={t(
          'admin.euAiAct.keys.generateMessage',
          'The new key becomes active. {{keyId}} becomes retired and is used for detection only. You must update vLLM afterwards.',
          { keyId: active?.keyId }
        )}
        confirmLabel={t('admin.euAiAct.keys.generate', 'Generate key')}
        onConfirm={generate}
        onDeny={() => setConfirmGenerate(false)}
      />
      <ConfirmDialog
        isOpen={Boolean(deleting)}
        title={t('admin.euAiAct.keys.deleteTitle', 'Delete retired key {{id}}?', { id: deleting })}
        message={t(
          'admin.euAiAct.keys.deleteMessage',
          'Text generated with this key can no longer be recognised as watermarked by this installation. This cannot be undone.'
        )}
        confirmLabel={t('admin.euAiAct.keys.deleteConfirm', 'Delete key')}
        danger
        onConfirm={confirmDelete}
        onDeny={() => setDeleting(null)}
      />
    </EuAiActCard>
  );
}
