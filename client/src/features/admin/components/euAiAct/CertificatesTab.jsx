import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  DocumentPlusIcon,
  KeyIcon,
  ShieldCheckIcon,
  TrashIcon
} from '@heroicons/react/24/outline';
import {
  activateCertificate,
  completeCertificateRequest,
  createCertificateRequest,
  fetchCertificates,
  fetchTrustAnchorPem,
  installCustomCertificate,
  removeCertificateRequest,
  rotateCertificate
} from './tabsApi';
import {
  downloadTextFile,
  extractApiError,
  formatDate,
  formatDateTime,
  readFileAsBase64,
  readFileAsText
} from './fileHelpers';
import {
  EMPTY_CUSTOM_CERTIFICATE_FORM,
  buildCsrBody,
  buildCustomCertificateBody,
  canRemove,
  canRollback,
  csrFileName,
  getExpiryState,
  isPlausibleEmail,
  validateCustomCertificateForm,
  validateIssuedCertificate
} from './certificatesModel';
import EuAiActDialog from './EuAiActDialog';
import {
  Button,
  CodeBlock,
  DefinitionList,
  LoadingRow,
  Notice,
  SectionCard,
  StatusPill,
  TABLE,
  TextField
} from './EuAiActUi';

const EMPTY_CSR_FORM = Object.freeze({ commonName: '', organization: '', email: '' });
const FILE_INPUT_CLASS =
  'block w-full text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-50 dark:file:bg-indigo-900/40 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-indigo-700 dark:file:text-indigo-300 hover:file:bg-indigo-100';

/**
 * Certificates tab of the EU AI Act admin page
 * (`/admin/eu-ai-act?tab=certificates`, concept §8.5).
 *
 * Shows the signing status and the active certificate, lists every stored
 * certificate (active, detect-only, pending) and offers: rotate the
 * auto-generated installation certificate, install a custom certificate (PEM
 * or PKCS#12), generate a key + CSR and install the issued certificate,
 * roll back to a detect-only certificate, and download the trust anchor.
 *
 * @param {Object} props
 * @param {Object} [props.status] - `GET /admin/ai-transparency/status` payload;
 *   `status.signing` is used as initial data until the tab has loaded its own
 * @param {() => void} [props.reload] - Refetches the status after a change
 */
function CertificatesTab({ status, reload }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const [data, setData] = useState(status?.signing || null);
  const [loadState, setLoadState] = useState(status?.signing ? 'ready' : 'loading');
  const [loadError, setLoadError] = useState('');
  const [result, setResult] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState(null);
  const [customForm, setCustomForm] = useState(EMPTY_CUSTOM_CERTIFICATE_FORM);
  const [customErrors, setCustomErrors] = useState({});
  const [csrForm, setCsrForm] = useState(EMPTY_CSR_FORM);
  const [csrEmailError, setCsrEmailError] = useState('');
  const [issued, setIssued] = useState({});
  const [issuedErrors, setIssuedErrors] = useState({});
  const [completingId, setCompletingId] = useState(null);
  const [downloadingAnchor, setDownloadingAnchor] = useState(false);
  const focusPendingIdRef = useRef(null);
  const firstCustomFieldRef = useRef(null);
  const firstCsrFieldRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchCertificates();
      setData(next);
      setLoadError('');
      setLoadState('ready');
    } catch (err) {
      setLoadError(extractApiError(err).message);
      setLoadState(prev => (prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // After creating a CSR, move focus to its pending card so the admin lands
  // on the CSR to copy.
  useEffect(() => {
    if (!focusPendingIdRef.current) return;
    const el = document.getElementById(`eu-cert-pending-${focusPendingIdRef.current}`);
    if (el) {
      focusPendingIdRef.current = null;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.focus({ preventScroll: true });
    }
  }, [data]);

  // ── Labels ────────────────────────────────────────────────────────────
  const sourceLabel = source => {
    switch (source) {
      case 'auto':
        return t('admin.euAiAct.certificates.source.auto', 'Auto-generated');
      case 'custom':
        return t('admin.euAiAct.certificates.source.custom', 'Custom');
      case 'csr':
        return t('admin.euAiAct.certificates.source.csr', 'CSR (issued by your CA)');
      default:
        return source || '—';
    }
  };

  const statusPill = certStatus => {
    switch (certStatus) {
      case 'active':
        return (
          <StatusPill tone="success">
            {t('admin.euAiAct.certificates.status.active', 'Active')}
          </StatusPill>
        );
      case 'detect-only':
        return (
          <StatusPill tone="neutral">
            {t('admin.euAiAct.certificates.status.detectOnly', 'Detect only')}
          </StatusPill>
        );
      case 'pending':
        return (
          <StatusPill tone="info">
            {t('admin.euAiAct.certificates.status.pending', 'Pending')}
          </StatusPill>
        );
      default:
        return <StatusPill>{certStatus || '—'}</StatusPill>;
    }
  };

  const expiryPill = certificate => {
    const state = getExpiryState(certificate);
    if (state === 'expired') {
      return (
        <StatusPill tone="error">
          {t('admin.euAiAct.certificates.expiry.expired', 'Expired')}
        </StatusPill>
      );
    }
    if (state === 'unknown') return <span>—</span>;
    const text = t('admin.euAiAct.certificates.expiry.daysLeft', '{{count}} days left', {
      count: certificate.expiresInDays
    });
    return <StatusPill tone={state === 'expiring' ? 'warning' : 'success'}>{text}</StatusPill>;
  };

  const testStateLabel = value => {
    if (value === 'Trusted') return t('admin.euAiAct.certificates.test.trusted', 'trusted');
    if (value === 'Valid') return t('admin.euAiAct.certificates.test.valid', 'valid');
    return t('admin.euAiAct.certificates.test.notRun', 'not tested');
  };

  const cancelLabel = t('admin.euAiAct.certificates.dialog.cancel', 'Cancel');
  const closeLabel = t('admin.euAiAct.certificates.dialog.close', 'Close dialog');

  const fieldErrorText = code => {
    switch (code) {
      case 'required':
        return t('admin.euAiAct.certificates.validation.required', 'This field is required.');
      case 'pemCertificate':
        return t(
          'admin.euAiAct.certificates.validation.pemCertificate',
          'Paste PEM certificates (they start with -----BEGIN CERTIFICATE-----).'
        );
      case 'pemKey':
        return t(
          'admin.euAiAct.certificates.validation.pemKey',
          'Paste a PEM private key (it starts with -----BEGIN PRIVATE KEY----- or similar).'
        );
      default:
        return undefined;
    }
  };

  // ── Shared result handling ────────────────────────────────────────────

  /** Show a success result (with test signature + warnings) and refresh. */
  const finishSuccess = async ({ title, response }) => {
    setResult({
      tone: 'success',
      title,
      test: response?.test || null,
      warnings: Array.isArray(response?.warnings) ? response.warnings : []
    });
    await load();
    reload?.();
  };

  const closeDialog = () => {
    if (busy) return;
    setDialog(null);
    setDialogError(null);
  };

  const openDialog = next => {
    setDialogError(null);
    setDialog(next);
  };

  // ── Actions ───────────────────────────────────────────────────────────

  const handleRotate = async () => {
    setBusy(true);
    setDialogError(null);
    try {
      const response = await rotateCertificate();
      setDialog(null);
      await finishSuccess({
        title: t(
          'admin.euAiAct.certificates.rotate.success',
          'New installation certificate issued: {{subject}}. The previous certificate is kept for detection only.',
          { subject: response?.certificate?.subject || '' }
        ),
        response
      });
    } catch (err) {
      setDialogError(extractApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async certificate => {
    setBusy(true);
    setDialogError(null);
    try {
      const response = await activateCertificate(certificate.id);
      setDialog(null);
      await finishSuccess({
        title: t('admin.euAiAct.certificates.rollback.success', 'Signing with {{subject}} again.', {
          subject: response?.certificate?.subject || certificate.subject
        }),
        response: null
      });
    } catch (err) {
      setDialogError(extractApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async certificate => {
    setBusy(true);
    setDialogError(null);
    try {
      await removeCertificateRequest(certificate.id);
      setDialog(null);
      await finishSuccess({
        title: t('admin.euAiAct.certificates.remove.success', 'Certificate request removed.'),
        response: null
      });
    } catch (err) {
      setDialogError(extractApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleInstallCustom = async () => {
    const errors = validateCustomCertificateForm(customForm);
    setCustomErrors(errors);
    if (Object.keys(errors).length > 0) {
      const firstId = {
        chainPem: 'eu-cert-custom-chain',
        keyPem: 'eu-cert-custom-key',
        pkcs12: 'eu-cert-custom-p12'
      }[Object.keys(errors)[0]];
      document.getElementById(firstId)?.focus();
      return;
    }
    setBusy(true);
    setDialogError(null);
    try {
      const response = await installCustomCertificate(buildCustomCertificateBody(customForm));
      setDialog(null);
      setCustomForm(EMPTY_CUSTOM_CERTIFICATE_FORM);
      await finishSuccess({
        title: t(
          'admin.euAiAct.certificates.custom.success',
          'Custom certificate installed: {{subject}}. The previous certificate is kept for detection only.',
          { subject: response?.certificate?.subject || '' }
        ),
        response
      });
    } catch (err) {
      setDialogError(extractApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateCsr = async () => {
    if (!isPlausibleEmail(csrForm.email)) {
      setCsrEmailError(
        t('admin.euAiAct.certificates.validation.email', 'Enter a valid e-mail address.')
      );
      document.getElementById('eu-cert-csr-email')?.focus();
      return;
    }
    setCsrEmailError('');
    setBusy(true);
    setDialogError(null);
    try {
      const response = await createCertificateRequest(buildCsrBody(csrForm));
      setDialog(null);
      setCsrForm(EMPTY_CSR_FORM);
      focusPendingIdRef.current = response?.certificate?.id || null;
      await finishSuccess({
        title: t(
          'admin.euAiAct.certificates.csr.success',
          'Key and certificate request created. Copy or download the CSR below, send it to your CA, then paste the issued certificate.'
        ),
        response: null
      });
    } catch (err) {
      setDialogError(extractApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleComplete = async certificate => {
    const pem = issued[certificate.id] || '';
    const code = validateIssuedCertificate(pem);
    if (code) {
      setIssuedErrors(prev => ({ ...prev, [certificate.id]: { message: fieldErrorText(code) } }));
      document.getElementById(`eu-cert-issued-${certificate.id}`)?.focus();
      return;
    }
    setCompletingId(certificate.id);
    setIssuedErrors(prev => ({ ...prev, [certificate.id]: null }));
    try {
      const response = await completeCertificateRequest(certificate.id, pem.trim());
      setIssued(prev => ({ ...prev, [certificate.id]: '' }));
      await finishSuccess({
        title: t(
          'admin.euAiAct.certificates.complete.success',
          'Issued certificate installed: {{subject}}.',
          { subject: response?.certificate?.subject || certificate.subject }
        ),
        response
      });
    } catch (err) {
      setIssuedErrors(prev => ({ ...prev, [certificate.id]: extractApiError(err) }));
    } finally {
      setCompletingId(null);
    }
  };

  const handleDownloadAnchor = async () => {
    setDownloadingAnchor(true);
    try {
      const pem = await fetchTrustAnchorPem();
      downloadTextFile('ihub-trust-anchor.pem', pem, 'application/x-pem-file');
    } catch (err) {
      const { message } = extractApiError(err);
      setResult({
        tone: 'error',
        title: t(
          'admin.euAiAct.certificates.anchor.error',
          'The trust anchor could not be downloaded: {{error}}',
          { error: message }
        )
      });
    } finally {
      setDownloadingAnchor(false);
    }
  };

  const loadPemFile = async (event, field) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      setCustomForm(prev => ({ ...prev, [field]: text }));
      setCustomErrors(prev => ({ ...prev, [field]: undefined }));
    } catch {
      setCustomErrors(prev => ({ ...prev, [field]: 'required' }));
    }
  };

  const loadPkcs12File = async event => {
    const file = event.target.files?.[0];
    if (!file) {
      setCustomForm(prev => ({ ...prev, pkcs12Base64: '', pkcs12FileName: '' }));
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      setCustomForm(prev => ({ ...prev, pkcs12Base64: base64, pkcs12FileName: file.name }));
      setCustomErrors(prev => ({ ...prev, pkcs12: undefined }));
    } catch {
      setCustomErrors(prev => ({ ...prev, pkcs12: 'required' }));
    }
  };

  // ── Render helpers ────────────────────────────────────────────────────

  /** Server error with its validation `details` list, shown inside dialogs. */
  const renderServerError = (error, title) =>
    error ? (
      <Notice tone="error" role="alert" title={title}>
        {error.message && <p>{error.message}</p>}
        {error.details?.length > 0 && (
          <ul className="list-disc pl-5">
            {error.details.map(detail => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}
      </Notice>
    ) : null;

  const renderChain = chain => {
    if (!Array.isArray(chain) || chain.length === 0) return null;
    return (
      <div>
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
          {t('admin.euAiAct.certificates.active.chain', 'Certificate chain')}
        </h4>
        <ol className="space-y-2">
          {chain.map((entry, index) => (
            <li
              key={entry.fingerprint || `${entry.subject}-${entry.notAfter}`}
              className="rounded-md border border-gray-200 dark:border-gray-700 p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                  {index === 0
                    ? t('admin.euAiAct.certificates.chain.leaf', 'Signing certificate')
                    : t('admin.euAiAct.certificates.chain.issuerLevel', 'Issuer {{level}}', {
                        level: index
                      })}
                </span>
                {entry.selfSigned && (
                  <StatusPill tone="info">
                    {t('admin.euAiAct.certificates.chain.selfSigned', 'Root (self-signed)')}
                  </StatusPill>
                )}
              </div>
              <p className="mt-1 text-gray-900 dark:text-gray-100 break-words">{entry.subject}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 break-words">
                {t('admin.euAiAct.certificates.chain.issuedBy', 'Issued by {{issuer}}', {
                  issuer: entry.issuer
                })}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('admin.euAiAct.certificates.chain.validity', 'Valid {{from}} – {{until}}', {
                  from: formatDate(entry.notBefore, locale),
                  until: formatDate(entry.notAfter, locale)
                })}
              </p>
              {Array.isArray(entry.ekus) && entry.ekus.length > 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400 break-words">
                  {t('admin.euAiAct.certificates.chain.ekus', 'Extended key usage: {{ekus}}', {
                    ekus: entry.ekus.join(', ')
                  })}
                </p>
              )}
              {entry.fingerprint && (
                <p className="mt-1 font-mono text-xs text-gray-600 dark:text-gray-400 break-all">
                  {entry.fingerprint}
                </p>
              )}
            </li>
          ))}
        </ol>
      </div>
    );
  };

  // ── Early states ──────────────────────────────────────────────────────

  if (loadState === 'loading') {
    return <LoadingRow label={t('admin.euAiAct.certificates.loading', 'Loading certificates…')} />;
  }

  if (loadState === 'error' || !data) {
    return (
      <Notice
        tone="error"
        role="alert"
        title={t('admin.euAiAct.certificates.loadError', 'The certificates could not be loaded.')}
      >
        {loadError && <p>{loadError}</p>}
        <div className="pt-2">
          <Button icon={ArrowPathIcon} onClick={load}>
            {t('admin.euAiAct.certificates.retry', 'Try again')}
          </Button>
        </div>
      </Notice>
    );
  }

  const certificates = Array.isArray(data.certificates) ? data.certificates : [];
  const active = data.active || null;
  const pending = certificates.filter(c => c.status === 'pending');
  const activeExpiry = getExpiryState(active);

  return (
    <div className="space-y-6">
      {/* Result of the last action (announced politely). */}
      <div aria-live="polite">
        {result && (
          <Notice tone={result.tone} title={result.title}>
            {result.test && (
              <p>
                {t(
                  'admin.euAiAct.certificates.test.summary',
                  'Test signature: JWS {{jws}}, C2PA {{c2pa}}.',
                  { jws: testStateLabel(result.test.jws), c2pa: testStateLabel(result.test.c2pa) }
                )}
              </p>
            )}
            {result.warnings?.length > 0 && (
              <>
                <p className="font-medium">
                  {t('admin.euAiAct.certificates.warningsTitle', 'Warnings')}
                </p>
                <ul className="list-disc pl-5">
                  {result.warnings.map(warning => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </>
            )}
          </Notice>
        )}
      </div>

      {loadError && (
        <Notice
          tone="warning"
          title={t(
            'admin.euAiAct.certificates.refreshError',
            'The list could not be refreshed: {{error}}',
            { error: loadError }
          )}
        />
      )}

      {/* ── Status ─────────────────────────────────────────────────────── */}
      <SectionCard
        id="eu-cert-status"
        title={t('admin.euAiAct.certificates.statusTitle', 'Signing status')}
        actions={
          <Button icon={ArrowDownTrayIcon} busy={downloadingAnchor} onClick={handleDownloadAnchor}>
            {t('admin.euAiAct.certificates.anchor.download', 'Download trust anchor (PEM)')}
          </Button>
        }
      >
        <DefinitionList
          items={[
            {
              label: t('admin.euAiAct.certificates.c2paLibrary', 'C2PA library'),
              value: data.c2paAvailable ? (
                <StatusPill tone="success">
                  {t('admin.euAiAct.certificates.available', 'Available')}
                </StatusPill>
              ) : (
                <StatusPill tone="error">
                  {t('admin.euAiAct.certificates.notAvailable', 'Not available')}
                </StatusPill>
              )
            },
            {
              label: t('admin.euAiAct.certificates.signing', 'Signing'),
              value: data.enabled ? (
                <StatusPill tone="success">
                  {t('admin.euAiAct.certificates.enabled', 'Enabled')}
                </StatusPill>
              ) : (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <StatusPill tone="error">
                    {t('admin.euAiAct.certificates.disabled', 'Disabled')}
                  </StatusPill>
                  <Link
                    to={{ search: '?tab=settings' }}
                    className="text-sm text-indigo-600 dark:text-indigo-400 underline"
                  >
                    {t('admin.euAiAct.certificates.openSettings', 'Open settings')}
                  </Link>
                </span>
              )
            },
            {
              label: t('admin.euAiAct.certificates.timestamping', 'Time-stamping'),
              value:
                data.timestamping === 'tsa' ? (
                  <span className="break-all">
                    {t('admin.euAiAct.certificates.timestampingTsa', 'RFC 3161 TSA: {{url}}', {
                      url: data.tsaUrl
                    })}
                  </span>
                ) : (
                  t(
                    'admin.euAiAct.certificates.timestampingLocal',
                    'Local clock of this server (no time-stamp authority configured)'
                  )
                )
            },
            {
              label: t('admin.euAiAct.certificates.trustedAnchors', 'Additional trusted anchors'),
              value: String(data.trustedAnchorCount ?? 0)
            }
          ]}
        />
        <Notice
          tone="info"
          title={t(
            'admin.euAiAct.certificates.trustInfo.title',
            'Why public validators may show “untrusted”'
          )}
        >
          <p>
            {t(
              'admin.euAiAct.certificates.trustInfo.body',
              'Auto-generated installation certificates validate cryptographically everywhere. Public validators such as contentcredentials.org show the signer as untrusted or unknown until its root is on the C2PA Trust List. This is accepted for now. The detector of this installation trusts its own root and the trusted anchors from the settings.'
            )}
          </p>
        </Notice>
      </SectionCard>

      {/* ── Active certificate ─────────────────────────────────────────── */}
      <SectionCard
        id="eu-cert-active"
        title={t('admin.euAiAct.certificates.active.title', 'Active certificate')}
        actions={
          <>
            <Button icon={ArrowPathIcon} onClick={() => openDialog({ type: 'rotate' })}>
              {t(
                'admin.euAiAct.certificates.rotate.button',
                'Issue new installation certificate (rotate)'
              )}
            </Button>
            <Button
              icon={ShieldCheckIcon}
              onClick={() => {
                setCustomErrors({});
                openDialog({ type: 'custom' });
              }}
            >
              {t('admin.euAiAct.certificates.custom.button', 'Install custom certificate')}
            </Button>
            <Button icon={KeyIcon} onClick={() => openDialog({ type: 'csr' })}>
              {t('admin.euAiAct.certificates.csr.button', 'Generate key + CSR')}
            </Button>
          </>
        }
      >
        {!active ? (
          <Notice
            tone="warning"
            title={t(
              'admin.euAiAct.certificates.active.none',
              'There is no active signing certificate.'
            )}
          >
            <p>
              {t(
                'admin.euAiAct.certificates.active.noneBody',
                'Issue an installation certificate or install your own certificate to sign content.'
              )}
            </p>
          </Notice>
        ) : (
          <>
            {activeExpiry === 'expiring' && (
              <Notice
                tone="warning"
                title={t(
                  'admin.euAiAct.certificates.active.expiringSoon',
                  'The signing certificate expires in {{count}} days.',
                  { count: active.expiresInDays }
                )}
              >
                <p>
                  {t(
                    'admin.euAiAct.certificates.active.expiringSoonBody',
                    'Rotate or install a new certificate before it expires.'
                  )}
                </p>
              </Notice>
            )}
            {activeExpiry === 'expired' && (
              <Notice
                tone="error"
                title={t(
                  'admin.euAiAct.certificates.active.expired',
                  'The signing certificate has expired.'
                )}
              >
                <p>
                  {t(
                    'admin.euAiAct.certificates.active.expiredBody',
                    'New content cannot be signed validly. Rotate or install a new certificate now.'
                  )}
                </p>
              </Notice>
            )}
            <DefinitionList
              items={[
                {
                  label: t('admin.euAiAct.certificates.fields.subject', 'Subject'),
                  value: active.subject || '—'
                },
                {
                  label: t('admin.euAiAct.certificates.fields.issuer', 'Issuer'),
                  value: active.issuer || '—'
                },
                {
                  label: t('admin.euAiAct.certificates.fields.source', 'Source'),
                  value: sourceLabel(active.source)
                },
                {
                  label: t('admin.euAiAct.certificates.fields.validity', 'Validity'),
                  value: t(
                    'admin.euAiAct.certificates.fields.validityRange',
                    '{{from}} – {{until}}',
                    {
                      from: formatDate(active.notBefore, locale),
                      until: formatDate(active.notAfter, locale)
                    }
                  )
                },
                {
                  label: t('admin.euAiAct.certificates.fields.daysLeft', 'Remaining'),
                  value: expiryPill(active)
                },
                {
                  label: t('admin.euAiAct.certificates.fields.activatedAt', 'Active since'),
                  value: formatDateTime(active.activatedAt || active.createdAt, locale)
                },
                {
                  label: t('admin.euAiAct.certificates.fields.serialNumber', 'Serial number'),
                  value: active.serialNumber || '—',
                  mono: true
                },
                {
                  label: t(
                    'admin.euAiAct.certificates.fields.fingerprint',
                    'Fingerprint (SHA-256)'
                  ),
                  value: active.fingerprint || '—',
                  mono: true
                }
              ]}
            />
            {renderChain(active.chain)}
          </>
        )}
      </SectionCard>

      {/* ── Pending certificate requests ───────────────────────────────── */}
      {pending.length > 0 && (
        <SectionCard
          id="eu-cert-pending"
          title={t('admin.euAiAct.certificates.pending.title', 'Pending certificate requests')}
          description={t(
            'admin.euAiAct.certificates.pending.description',
            'The private key was generated on this server and never leaves it. Send the CSR to your CA, then paste the issued certificate with its chain.'
          )}
        >
          {pending.map(certificate => {
            const issuedId = `eu-cert-issued-${certificate.id}`;
            const issuedError = issuedErrors[certificate.id];
            return (
              <div
                key={certificate.id}
                id={`eu-cert-pending-${certificate.id}`}
                tabIndex={-1}
                className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-4 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words">
                      {certificate.subject}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {t('admin.euAiAct.certificates.pending.created', 'Created {{date}}', {
                        date: formatDateTime(certificate.createdAt, locale)
                      })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={TrashIcon}
                    onClick={() => openDialog({ type: 'remove', certificate })}
                  >
                    {t('admin.euAiAct.certificates.remove.button', 'Remove request')}
                  </Button>
                </div>
                {certificate.csrPem && (
                  <CodeBlock
                    code={certificate.csrPem}
                    label={t(
                      'admin.euAiAct.certificates.pending.csrLabel',
                      'Certificate signing request (PEM)'
                    )}
                    copyLabel={t('admin.euAiAct.certificates.copy', 'Copy')}
                    copiedLabel={t('admin.euAiAct.certificates.copied', 'Copied')}
                    copyFailedLabel={t('admin.euAiAct.certificates.copyFailed', 'Copying failed')}
                    extraActions={
                      <Button
                        size="sm"
                        icon={ArrowDownTrayIcon}
                        onClick={() =>
                          downloadTextFile(
                            csrFileName(certificate),
                            certificate.csrPem,
                            'application/pkcs10'
                          )
                        }
                      >
                        {t('admin.euAiAct.certificates.pending.downloadCsr', 'Download CSR')}
                      </Button>
                    }
                  />
                )}
                <TextField
                  id={issuedId}
                  multiline
                  rows={6}
                  mono
                  value={issued[certificate.id] || ''}
                  onChange={value => setIssued(prev => ({ ...prev, [certificate.id]: value }))}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  label={t(
                    'admin.euAiAct.certificates.pending.issuedLabel',
                    'Paste issued certificate (PEM, with chain)'
                  )}
                  error={
                    issuedError && !issuedError.details?.length ? issuedError.message : undefined
                  }
                />
                {issuedError?.details?.length > 0 &&
                  renderServerError(
                    issuedError,
                    t(
                      'admin.euAiAct.certificates.complete.error',
                      'The issued certificate was rejected.'
                    )
                  )}
                <div className="flex justify-end">
                  <Button
                    variant="primary"
                    icon={DocumentPlusIcon}
                    busy={completingId === certificate.id}
                    disabled={completingId !== null && completingId !== certificate.id}
                    onClick={() => handleComplete(certificate)}
                  >
                    {t('admin.euAiAct.certificates.complete.button', 'Install issued certificate')}
                  </Button>
                </div>
              </div>
            );
          })}
        </SectionCard>
      )}

      {/* ── All certificates ───────────────────────────────────────────── */}
      <SectionCard
        id="eu-cert-all"
        title={t('admin.euAiAct.certificates.all.title', 'All certificates')}
        description={t(
          'admin.euAiAct.certificates.all.description',
          'Retired certificates stay detect-only, so content they signed can still be verified.'
        )}
      >
        <div className={TABLE.wrapper}>
          <table className={TABLE.table}>
            <caption className="sr-only">
              {t(
                'admin.euAiAct.certificates.all.caption',
                'Signing certificates of this installation'
              )}
            </caption>
            <thead className={TABLE.thead}>
              <tr>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.certificates.fields.subject', 'Subject')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.certificates.fields.source', 'Source')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.certificates.fields.status', 'Status')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.certificates.fields.validUntil', 'Valid until')}
                </th>
                <th scope="col" className={TABLE.thRight}>
                  {t('admin.euAiAct.certificates.fields.actions', 'Actions')}
                </th>
              </tr>
            </thead>
            <tbody className={TABLE.tbody}>
              {certificates.length === 0 && (
                <tr>
                  <td colSpan={5} className={TABLE.empty}>
                    {t('admin.euAiAct.certificates.all.empty', 'No certificates yet.')}
                  </td>
                </tr>
              )}
              {certificates.map(certificate => (
                <tr key={certificate.id} className={TABLE.tr}>
                  <td className={TABLE.td}>
                    <div className="text-gray-900 dark:text-gray-100 break-words">
                      {certificate.subject || '—'}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 break-words">
                      {certificate.issuer}
                    </div>
                    {certificate.fingerprint && (
                      <div
                        className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all"
                        title={certificate.fingerprint}
                      >
                        {certificate.fingerprint.slice(0, 23)}…
                      </div>
                    )}
                  </td>
                  <td className={TABLE.td}>{sourceLabel(certificate.source)}</td>
                  <td className={TABLE.td}>{statusPill(certificate.status)}</td>
                  <td className={TABLE.td}>
                    <div>{formatDate(certificate.notAfter, locale)}</div>
                    {certificate.status !== 'pending' && (
                      <div className="mt-1">{expiryPill(certificate)}</div>
                    )}
                  </td>
                  <td className={TABLE.tdRight}>
                    <div className="flex flex-wrap justify-end gap-2">
                      {canRollback(certificate) && (
                        <Button
                          size="sm"
                          icon={ArrowUturnLeftIcon}
                          onClick={() => openDialog({ type: 'activate', certificate })}
                          aria-label={t(
                            'admin.euAiAct.certificates.rollback.buttonAria',
                            'Use {{subject}} again (rollback)',
                            { subject: certificate.subject }
                          )}
                        >
                          {t('admin.euAiAct.certificates.rollback.button', 'Use again (rollback)')}
                        </Button>
                      )}
                      {canRemove(certificate) && (
                        <Button
                          size="sm"
                          icon={TrashIcon}
                          onClick={() => openDialog({ type: 'remove', certificate })}
                          aria-label={t(
                            'admin.euAiAct.certificates.remove.buttonAria',
                            'Remove request {{subject}}',
                            { subject: certificate.subject }
                          )}
                        >
                          {t('admin.euAiAct.certificates.remove.short', 'Remove')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* ── IntraFind certificate (future, #2578) ───────────────────────── */}
      <SectionCard
        id="eu-cert-intrafind"
        title={t('admin.euAiAct.certificates.intrafind.title', 'Use IntraFind certificate')}
      >
        <p id="eu-cert-intrafind-desc" className="text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.euAiAct.certificates.intrafind.body',
            'Not available yet (issue #2578). Registered installations will be able to switch to IntraFind’s C2PA certificate from a CA on the C2PA Trust List with one click, so public validators show the signer as trusted. This needs iHub’s C2PA conformance first. Until then, use the installation certificate or install your own.'
          )}
        </p>
        <div>
          <Button
            icon={ShieldCheckIcon}
            aria-disabled="true"
            aria-describedby="eu-cert-intrafind-desc"
            className="opacity-50 cursor-not-allowed"
            onClick={event => event.preventDefault()}
          >
            {t('admin.euAiAct.certificates.intrafind.button', 'Use IntraFind certificate')}
          </Button>
        </div>
      </SectionCard>

      {/* ── Dialogs ────────────────────────────────────────────────────── */}
      <EuAiActDialog
        open={dialog?.type === 'rotate'}
        focusCancel
        title={t(
          'admin.euAiAct.certificates.rotate.title',
          'Issue a new installation certificate?'
        )}
        description={
          <p>
            {t(
              'admin.euAiAct.certificates.rotate.body',
              'iHub creates a new installation root and signing certificate and signs all new content with it. The current certificate stays detect-only, so content it signed can still be verified. Other installations that trust the old root need the new trust anchor.'
            )}
          </p>
        }
        onClose={closeDialog}
        onSubmit={handleRotate}
        submitting={busy}
        submitLabel={t('admin.euAiAct.certificates.rotate.confirm', 'Issue new certificate')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
      >
        {renderServerError(
          dialogError,
          t('admin.euAiAct.certificates.rotate.error', 'The certificate could not be issued.')
        )}
      </EuAiActDialog>

      <EuAiActDialog
        open={dialog?.type === 'activate'}
        focusCancel
        title={t('admin.euAiAct.certificates.rollback.title', 'Sign with this certificate again?')}
        description={
          <p>
            {t(
              'admin.euAiAct.certificates.rollback.body',
              'New content will be signed with {{subject}} again. The currently active certificate becomes detect-only.',
              { subject: dialog?.certificate?.subject || '' }
            )}
          </p>
        }
        onClose={closeDialog}
        onSubmit={() => handleActivate(dialog.certificate)}
        submitting={busy}
        submitLabel={t('admin.euAiAct.certificates.rollback.confirm', 'Use again')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
      >
        {renderServerError(
          dialogError,
          t('admin.euAiAct.certificates.rollback.error', 'The certificate could not be activated.')
        )}
      </EuAiActDialog>

      <EuAiActDialog
        open={dialog?.type === 'remove'}
        danger
        focusCancel
        title={t('admin.euAiAct.certificates.remove.title', 'Remove this certificate request?')}
        description={
          <p>
            {t(
              'admin.euAiAct.certificates.remove.body',
              'The generated private key is deleted. A certificate your CA issues for this request can no longer be installed.'
            )}
          </p>
        }
        onClose={closeDialog}
        onSubmit={() => handleRemove(dialog.certificate)}
        submitting={busy}
        submitLabel={t('admin.euAiAct.certificates.remove.confirm', 'Remove request')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
      >
        {renderServerError(
          dialogError,
          t('admin.euAiAct.certificates.remove.error', 'The request could not be removed.')
        )}
      </EuAiActDialog>

      <EuAiActDialog
        open={dialog?.type === 'custom'}
        size="lg"
        title={t('admin.euAiAct.certificates.custom.title', 'Install custom certificate')}
        description={
          <p>
            {t(
              'admin.euAiAct.certificates.custom.body',
              'Use a certificate from your own PKI or from a CA on the C2PA Trust List. iHub checks the chain, the extended key usage, the key match and the expiry, and runs a test signature before switching over. The current certificate stays detect-only.'
            )}
          </p>
        }
        onClose={closeDialog}
        onSubmit={handleInstallCustom}
        submitting={busy}
        submitLabel={t('admin.euAiAct.certificates.custom.confirm', 'Validate and install')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
        initialFocusRef={firstCustomFieldRef}
      >
        <fieldset>
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('admin.euAiAct.certificates.custom.format', 'Format')}
          </legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {[
              {
                value: 'pem',
                label: t('admin.euAiAct.certificates.custom.formatPem', 'PEM (chain + private key)')
              },
              {
                value: 'pkcs12',
                label: t('admin.euAiAct.certificates.custom.formatPkcs12', 'PKCS#12 (.p12 / .pfx)')
              }
            ].map((option, index) => (
              <label
                key={option.value}
                className="inline-flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100"
              >
                <input
                  ref={index === 0 ? firstCustomFieldRef : undefined}
                  type="radio"
                  name="eu-cert-custom-mode"
                  value={option.value}
                  checked={customForm.mode === option.value}
                  onChange={() => {
                    setCustomForm(prev => ({ ...prev, mode: option.value }));
                    setCustomErrors({});
                  }}
                  className="h-4 w-4 border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        {customForm.mode === 'pem' ? (
          <>
            <div>
              <label
                htmlFor="eu-cert-custom-chain-file"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t(
                  'admin.euAiAct.certificates.custom.chainFile',
                  'Load certificate chain from file'
                )}
              </label>
              <input
                id="eu-cert-custom-chain-file"
                type="file"
                accept=".pem,.crt,.cer,.txt"
                onChange={event => loadPemFile(event, 'chainPem')}
                className={`mt-1 ${FILE_INPUT_CLASS}`}
              />
            </div>
            <TextField
              id="eu-cert-custom-chain"
              multiline
              rows={7}
              mono
              value={customForm.chainPem}
              onChange={value => setCustomForm(prev => ({ ...prev, chainPem: value }))}
              placeholder="-----BEGIN CERTIFICATE-----"
              label={t('admin.euAiAct.certificates.custom.chainPem', 'Certificate chain (PEM)')}
              hint={t(
                'admin.euAiAct.certificates.custom.chainPemHint',
                'Signing certificate first, then the intermediate certificates.'
              )}
              error={fieldErrorText(customErrors.chainPem)}
            />
            <div>
              <label
                htmlFor="eu-cert-custom-key-file"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.euAiAct.certificates.custom.keyFile', 'Load private key from file')}
              </label>
              <input
                id="eu-cert-custom-key-file"
                type="file"
                accept=".pem,.key,.txt"
                onChange={event => loadPemFile(event, 'keyPem')}
                className={`mt-1 ${FILE_INPUT_CLASS}`}
              />
            </div>
            <TextField
              id="eu-cert-custom-key"
              multiline
              rows={5}
              mono
              autoComplete="off"
              value={customForm.keyPem}
              onChange={value => setCustomForm(prev => ({ ...prev, keyPem: value }))}
              placeholder="-----BEGIN PRIVATE KEY-----"
              label={t('admin.euAiAct.certificates.custom.keyPem', 'Private key (PEM)')}
              hint={t(
                'admin.euAiAct.certificates.custom.keyPemHint',
                'Stored encrypted on the server. Prefer “Generate key + CSR” if the key does not have to come from elsewhere.'
              )}
              error={fieldErrorText(customErrors.keyPem)}
            />
          </>
        ) : (
          <>
            <div>
              <label
                htmlFor="eu-cert-custom-p12"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.euAiAct.certificates.custom.pkcs12File', 'PKCS#12 file')}
              </label>
              <input
                id="eu-cert-custom-p12"
                type="file"
                accept=".p12,.pfx,application/x-pkcs12"
                onChange={loadPkcs12File}
                aria-invalid={customErrors.pkcs12 ? true : undefined}
                aria-describedby={customErrors.pkcs12 ? 'eu-cert-custom-p12-error' : undefined}
                className={`mt-1 ${FILE_INPUT_CLASS}`}
              />
              {customErrors.pkcs12 && (
                <p
                  id="eu-cert-custom-p12-error"
                  className="mt-1 text-xs text-red-600 dark:text-red-400"
                >
                  {t('admin.euAiAct.certificates.validation.pkcs12', 'Choose a PKCS#12 file.')}
                </p>
              )}
              {customForm.pkcs12FileName && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t('admin.euAiAct.certificates.custom.pkcs12Selected', 'Selected: {{name}}', {
                    name: customForm.pkcs12FileName
                  })}
                </p>
              )}
            </div>
            <TextField
              id="eu-cert-custom-password"
              type="password"
              autoComplete="off"
              value={customForm.password}
              onChange={value => setCustomForm(prev => ({ ...prev, password: value }))}
              label={t('admin.euAiAct.certificates.custom.password', 'Password')}
              hint={t(
                'admin.euAiAct.certificates.custom.passwordHint',
                'Leave empty if the file has no password.'
              )}
            />
          </>
        )}

        {renderServerError(
          dialogError,
          t('admin.euAiAct.certificates.custom.error', 'The certificate was rejected.')
        )}
      </EuAiActDialog>

      <EuAiActDialog
        open={dialog?.type === 'csr'}
        title={t('admin.euAiAct.certificates.csr.title', 'Generate key and certificate request')}
        description={
          <p>
            {t(
              'admin.euAiAct.certificates.csr.body',
              'iHub generates the key pair on this server; the private key never leaves it. You get a CSR to send to your CA and install the issued certificate afterwards. All fields are optional; empty fields use the signing and provider settings.'
            )}
          </p>
        }
        onClose={closeDialog}
        onSubmit={handleCreateCsr}
        submitting={busy}
        submitLabel={t('admin.euAiAct.certificates.csr.confirm', 'Generate CSR')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
        initialFocusRef={firstCsrFieldRef}
      >
        <TextField
          ref={firstCsrFieldRef}
          id="eu-cert-csr-cn"
          value={csrForm.commonName}
          onChange={value => setCsrForm(prev => ({ ...prev, commonName: value }))}
          label={t('admin.euAiAct.certificates.csr.commonName', 'Common name')}
          maxLength={200}
        />
        <TextField
          id="eu-cert-csr-org"
          value={csrForm.organization}
          onChange={value => setCsrForm(prev => ({ ...prev, organization: value }))}
          label={t('admin.euAiAct.certificates.csr.organization', 'Organization')}
          autoComplete="organization"
          maxLength={200}
        />
        <TextField
          id="eu-cert-csr-email"
          type="email"
          value={csrForm.email}
          onChange={value => setCsrForm(prev => ({ ...prev, email: value }))}
          label={t('admin.euAiAct.certificates.csr.email', 'E-mail')}
          autoComplete="email"
          error={csrEmailError || undefined}
        />
        {renderServerError(
          dialogError,
          t('admin.euAiAct.certificates.csr.error', 'The request could not be created.')
        )}
      </EuAiActDialog>
    </div>
  );
}

export default CertificatesTab;
