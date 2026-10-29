// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import ConfirmDialog from '../../../../shared/components/ConfirmDialog';
import AdminLoadError from '../AdminLoadError';
import AdminPageSkeleton from '../AdminPageSkeleton';
import CertificateDetails, { CertificateBadges } from './CertificateDetails';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  DANGER_BUTTON_CLASS,
  HELP_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from './formStyles';
import {
  deleteDirectoryCertificate,
  fetchDirectoryCertificates,
  previewDirectoryCertificate,
  uploadDirectoryCertificate
} from '../../../../api/peopleDirectoriesAdminApi';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import {
  CERTIFICATE_NAME_PATTERN,
  certificateNameFromFileName,
  readCertificateFile
} from '../../utils/peopleDirectories';

/**
 * The Certificates tab: the store of trust anchors (`contents/config/certs/`)
 * that directories name in `tlsCa`, for directories whose server certificate
 * comes from a private CA (a corporate PKI, the Verwaltungs-PKI of
 * x500.bund.de).
 *
 * Uploading is two steps on purpose. The file is parsed first and its subject,
 * validity and SHA-256 fingerprint are shown; only after the admin confirms
 * that the fingerprint matches the publisher's does "Save certificate" store
 * it. A trust anchor is an admin decision, never something iHub adds itself.
 * Private keys are rejected by the server.
 *
 * A certificate in use by a directory cannot be removed; the page says which
 * directories use it.
 */
function CertificatesTab() {
  const { t } = useTranslation();
  const [certificates, setCertificates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [message, setMessage] = useState(null);
  const [upload, setUpload] = useState(null); // { fileName, payload, preview, name, confirmed }
  const [uploadError, setUploadError] = useState(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    try {
      setCertificates(await fetchDirectoryCertificates());
      setLoadError(null);
    } catch (err) {
      setLoadError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetUpload = () => {
    setUpload(null);
    setUploadError(null);
    setFileInputKey(key => key + 1);
  };

  const onFile = async event => {
    const file = event.target.files?.[0];
    setUpload(null);
    setUploadError(null);
    setMessage(null);
    if (!file) return;
    setReading(true);
    try {
      const payload = await readCertificateFile(file);
      const preview = await previewDirectoryCertificate(payload.content, payload.encoding);
      setUpload({
        fileName: file.name,
        payload,
        preview,
        name: certificateNameFromFileName(file.name),
        confirmed: false
      });
    } catch (err) {
      setUploadError(getAdminApiErrorMessage(err));
    } finally {
      setReading(false);
    }
  };

  const name = upload?.name ?? '';
  const nameError = !upload
    ? null
    : !CERTIFICATE_NAME_PATTERN.test(name)
      ? t(
          'admin.peopleDirectories.certificates.nameInvalid',
          'Use 1 to 64 lower-case letters, digits and "-".'
        )
      : certificates.some(c => c.name === name)
        ? t(
            'admin.peopleDirectories.certificates.nameTaken',
            'A certificate with this name exists already.'
          )
        : null;

  const save = async () => {
    if (!upload || nameError || !upload.confirmed) return;
    setSaving(true);
    setUploadError(null);
    try {
      await uploadDirectoryCertificate({ name, ...upload.payload });
      setMessage({
        type: 'success',
        text: t('admin.peopleDirectories.certificates.saved', 'Certificate "{{name}}" saved.', {
          name
        })
      });
      resetUpload();
      await load();
    } catch (err) {
      setUploadError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await deleteDirectoryCertificate(target);
      setMessage({
        type: 'success',
        text: t('admin.peopleDirectories.certificates.removed', 'Certificate "{{name}}" removed.', {
          name: target
        })
      });
      await load();
    } catch (err) {
      const usedBy = err?.response?.data?.usedBy;
      setMessage({
        type: 'error',
        text: Array.isArray(usedBy)
          ? t(
              'admin.peopleDirectories.certificates.inUseError',
              'Certificate "{{name}}" is still used by: {{directories}}.',
              { name: target, directories: usedBy.join(', ') }
            )
          : getAdminApiErrorMessage(err)
      });
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t(
          'admin.peopleDirectories.certificates.intro',
          'Trust anchors for directories whose server certificate comes from a private CA. A directory trusts only the certificates selected in its Network section; nothing here is trusted globally.'
        )}
      </p>

      {message &&
        (message.type === 'error' ? (
          <AdminLoadError framed={false} action={null} message={message.text} />
        ) : (
          <div role="status" className={CALLOUT_CLASS.success}>
            {message.text}
          </div>
        ))}

      <section
        aria-labelledby="pd-cert-upload-title"
        className="bg-white dark:bg-gray-800 shadow-xs border border-gray-200 dark:border-gray-700 rounded-lg p-6"
      >
        <h2
          id="pd-cert-upload-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('admin.peopleDirectories.certificates.uploadTitle', 'Add a certificate')}
        </h2>
        <div className="mt-4">
          <label htmlFor="pd-cert-file" className={LABEL_CLASS}>
            {t('admin.peopleDirectories.certificates.file', 'Certificate file (PEM or DER)')}
          </label>
          <input
            key={fileInputKey}
            id="pd-cert-file"
            type="file"
            accept=".pem,.crt,.cer,.der,application/x-pem-file,application/pkix-cert,application/x-x509-ca-cert"
            onChange={onFile}
            aria-describedby="pd-cert-file-help"
            className="block w-full text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:rounded-md file:border file:border-gray-300 dark:file:border-gray-600 file:bg-white dark:file:bg-gray-700 file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-700 dark:file:text-gray-200 hover:file:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-blue-500 rounded-md"
          />
          <p id="pd-cert-file-help" className={HELP_CLASS}>
            {t(
              'admin.peopleDirectories.certificates.fileHelp',
              '.pem, .crt, .cer or .der with one certificate. Files with a private key are refused.'
            )}
          </p>
        </div>

        {reading && (
          <p role="status" className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            {t('admin.peopleDirectories.certificates.reading', 'Reading the certificate…')}
          </p>
        )}

        {uploadError && (
          <AdminLoadError
            framed={false}
            action={null}
            className="mt-4"
            title={t(
              'admin.peopleDirectories.certificates.uploadError',
              'Certificate not accepted'
            )}
            message={uploadError}
          />
        )}

        {upload?.preview && (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {upload.preview.subjectCN || upload.fileName}
              </h3>
              <CertificateBadges certificate={upload.preview} />
            </div>
            <CertificateDetails certificate={upload.preview} />
            <div className={CALLOUT_CLASS.warning} role="note">
              {t(
                'admin.peopleDirectories.certificates.compareFingerprint',
                'Compare the SHA-256 fingerprint with the one the publisher lists (for the Verwaltungs-PKI: the BSI fingerprint page) before you save. Do not save a certificate whose fingerprint you cannot confirm.'
              )}
            </div>
            <div>
              <label htmlFor="pd-cert-name" className={LABEL_CLASS}>
                {t('admin.peopleDirectories.certificates.name', 'Name in the store')}
              </label>
              <input
                id="pd-cert-name"
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                value={name}
                onChange={e => setUpload(prev => ({ ...prev, name: e.target.value }))}
                aria-invalid={nameError ? 'true' : undefined}
                aria-describedby="pd-cert-name-help"
                className={MONO_INPUT_CLASS}
              />
              <p
                id="pd-cert-name-help"
                className={nameError ? 'mt-1 text-xs text-red-800 dark:text-red-300' : HELP_CLASS}
              >
                {nameError ||
                  t(
                    'admin.peopleDirectories.certificates.nameHelp',
                    'Directories name the certificate by this in "tlsCa".'
                  )}
              </p>
            </div>
            <label className="flex items-start gap-3">
              <input
                id="pd-cert-confirm"
                type="checkbox"
                checked={upload.confirmed}
                onChange={e => setUpload(prev => ({ ...prev, confirmed: e.target.checked }))}
                className={`${CHECKBOX_CLASS} mt-0.5`}
              />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t(
                  'admin.peopleDirectories.certificates.confirm',
                  "I compared the fingerprint with the publisher's, and it matches."
                )}
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={save}
                disabled={saving || Boolean(nameError) || !upload.confirmed}
                className={PRIMARY_BUTTON_CLASS}
              >
                <Icon name="upload" size="sm" />
                {saving
                  ? t('admin.peopleDirectories.certificates.saving', 'Saving…')
                  : t('admin.peopleDirectories.certificates.save', 'Save certificate')}
              </button>
              <button type="button" onClick={resetUpload} className={SECONDARY_BUTTON_CLASS}>
                {t('common.cancel', 'Cancel')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="pd-cert-list-title">
        <h2
          id="pd-cert-list-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3"
        >
          {t('admin.peopleDirectories.certificates.listTitle', 'Certificates in the store')}
        </h2>
        {loading ? (
          <AdminPageSkeleton rows={2} hasHeader={false} />
        ) : loadError ? (
          <AdminLoadError
            framed={false}
            message={loadError}
            title={t(
              'admin.peopleDirectories.certificates.loadError',
              'The certificate store could not be loaded'
            )}
            action={{ label: t('common.retry', 'Retry'), onClick: load }}
          />
        ) : certificates.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('admin.peopleDirectories.certificates.empty', 'The store is empty.')}
          </p>
        ) : (
          <ul className="space-y-4">
            {certificates.map(certificate => {
              const usedBy = Array.isArray(certificate.usedBy) ? certificate.usedBy : [];
              const inUseId = `pd-cert-in-use-${certificate.name}`;
              return (
                <li
                  key={certificate.name}
                  className="bg-white dark:bg-gray-800 shadow-xs border border-gray-200 dark:border-gray-700 rounded-lg p-5"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                          {certificate.subjectCN || certificate.name}
                        </h3>
                        <CertificateBadges certificate={certificate} />
                      </div>
                      <p className="mt-0.5 font-mono text-xs text-gray-600 dark:text-gray-400">
                        {certificate.name}
                      </p>
                    </div>
                    <div className="flex flex-col items-start gap-1 sm:items-end">
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(certificate.name)}
                        disabled={usedBy.length > 0}
                        aria-describedby={usedBy.length > 0 ? inUseId : undefined}
                        className={DANGER_BUTTON_CLASS}
                      >
                        <Icon name="trash" size="sm" />
                        {t('admin.peopleDirectories.certificates.remove', 'Remove')}
                        <span className="sr-only"> {certificate.name}</span>
                      </button>
                      {usedBy.length > 0 && (
                        <p
                          id={inUseId}
                          className="max-w-xs text-xs text-gray-600 dark:text-gray-400 sm:text-right"
                        >
                          {t(
                            'admin.peopleDirectories.certificates.inUse',
                            'In use — remove it from these directories first.'
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-4">
                    <CertificateDetails certificate={certificate} />
                  </div>
                  <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
                    <span className="font-medium">
                      {t('admin.peopleDirectories.certificates.usedBy', 'Used by')}:
                    </span>{' '}
                    {usedBy.length > 0
                      ? usedBy.join(', ')
                      : t('admin.peopleDirectories.certificates.unused', 'no directory')}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={t('admin.peopleDirectories.certificates.removeTitle', 'Remove certificate')}
        message={t(
          'admin.peopleDirectories.certificates.removeConfirm',
          'Remove "{{name}}" from the certificate store?',
          { name: deleteTarget }
        )}
        confirmLabel={t('admin.peopleDirectories.certificates.remove', 'Remove')}
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={confirmDelete}
        onDeny={() => setDeleteTarget(null)}
      />
    </div>
  );
}

export default CertificatesTab;
