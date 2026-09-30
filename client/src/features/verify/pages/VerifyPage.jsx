import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import IHubLogo from '../../../shared/components/IHubLogo';
import BrandTitle from '../../../shared/components/BrandTitle';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { buildAssetUrl } from '../../../utils/runtimeBasePath';
import { saveBlobAs } from '../../../utils/externalNavigation';
import { formatDateTimeForFilename } from '../../../utils/exportFormats';
import { fetchProvenanceInfo, verifyProvenanceContent } from '../../../api/endpoints/provenance';
import VerifyContentForm from '../components/VerifyContentForm';
import VerificationResult, { VerdictSummary } from '../components/VerificationResult';
import SignedReportCheck from '../components/SignedReportCheck';
import {
  buildReportFileContent,
  describeVerifyError,
  getVerifyAvailability
} from '../utils/verifyResult';

/**
 * Message for every state that is not the detector itself (unavailable,
 * sign-in required, no access, load failure).
 *
 * @param {Object} props
 * @param {string} props.icon
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {React.ReactNode} [props.children] - Optional action
 * @returns {JSX.Element}
 */
function StateMessage({ icon, title, description, children }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <Icon name={icon} size="2xl" className="mx-auto mb-4 text-gray-300 dark:text-gray-600" />
      <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {description && (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{description}</p>
      )}
      {children}
    </div>
  );
}

/**
 * Public `/verify` page (EU AI Act Art. 50(2); issue #2573, concept §8.4).
 *
 * Upload a file or paste text and see whether it carries an AI marking —
 * which technique found it, whether its signature is trusted, the content's
 * hash and, when this installation generated it, its provenance record — plus
 * a signed detection report to download (CoP 2.1.2). A second section checks
 * such a report.
 *
 * Rendered outside the app `Layout`: with the detector access set to
 * `public` it has to work for a visitor who is not signed in. Who may use it
 * is decided by the server (`GET /api/provenance/info`).
 *
 * @returns {JSX.Element}
 */
function VerifyPage() {
  const { t, i18n } = useTranslation();
  const { uiConfig } = useUIConfig();
  const currentLanguage = i18n.language || 'en';

  const [info, setInfo] = useState(null);
  const [infoError, setInfoError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [verifyError, setVerifyError] = useState(null);
  const [downloadError, setDownloadError] = useState(null);

  // What this viewer may do; fetched again after `reloadInfo()`.
  useEffect(() => {
    let active = true;
    fetchProvenanceInfo()
      .then(data => {
        if (active) setInfo(data || { enabled: false });
      })
      .catch(error => {
        if (active) setInfoError(error);
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const reloadInfo = useCallback(() => {
    setInfo(null);
    setInfoError(null);
    setReloadKey(k => k + 1);
  }, []);

  const pageTitle = t('verify.pageTitle', 'Verify content');
  useEffect(() => {
    const previousTitle = document.title;
    document.title = pageTitle;
    return () => {
      document.title = previousTitle;
    };
  }, [pageTitle]);

  const handleVerify = useCallback(
    async input => {
      setBusy(true);
      setVerifyError(null);
      setDownloadError(null);
      setOutcome(null);
      try {
        setOutcome(await verifyProvenanceContent(input));
      } catch (error) {
        const { key, fallback, params } = describeVerifyError(error);
        setVerifyError(t(key, { defaultValue: fallback, ...(params || {}) }));
        // The session may have ended, or the admin changed the access level.
        if (error?.status === 401 || error?.status === 403 || error?.status === 404) {
          reloadInfo();
        }
      } finally {
        setBusy(false);
      }
    },
    [t, reloadInfo]
  );

  const handleDownloadReport = () => {
    setDownloadError(null);
    const blob = new Blob([buildReportFileContent(outcome)], { type: 'application/json' });
    const filename = `verification-report-${formatDateTimeForFilename()}.json`;
    if (!saveBlobAs(blob, filename)) {
      setDownloadError(t('verify.result.downloadFailed', 'The report could not be downloaded.'));
    }
  };

  const availability = infoError ? 'error' : getVerifyAvailability(info);
  const returnUrl = `${window.location.pathname}${window.location.search}`;
  const logoUrl = uiConfig?.header?.logo?.url;

  let body;
  if (availability === 'loading') {
    body = (
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner size="lg" />
        <span className="sr-only">{t('verify.loading', 'Loading…')}</span>
      </div>
    );
  } else if (availability === 'error') {
    body = (
      <StateMessage
        icon="warning"
        title={t('verify.loadFailed', 'The detector could not be reached.')}
        description={t('verify.loadFailedHint', 'Check your connection and try again.')}
      >
        <button
          type="button"
          onClick={reloadInfo}
          className="mt-6 text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:underline"
        >
          {t('verify.retry', 'Try again')}
        </button>
      </StateMessage>
    );
  } else if (availability === 'disabled') {
    body = (
      <StateMessage
        icon="shield-exclamation"
        title={t('verify.unavailable.title', 'Detection is not available on this installation')}
        description={t(
          'verify.unavailable.description',
          'The administrator has not switched on content detection here.'
        )}
      />
    );
  } else if (availability === 'signin') {
    body = (
      <StateMessage
        icon="lock-closed"
        title={t('verify.signin.title', 'Sign in to check content')}
        description={t(
          'verify.signin.description',
          'The detector of this installation is available to signed-in users. Sign in and you will be brought back here.'
        )}
      >
        <Link
          to={`/login?returnUrl=${encodeURIComponent(returnUrl)}`}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          <Icon name="login" size="sm" />
          {t('verify.signin.action', 'Sign in')}
        </Link>
      </StateMessage>
    );
  } else if (availability === 'forbidden') {
    body = (
      <StateMessage
        icon="lock-closed"
        title={t('verify.forbidden.title', 'You do not have access to the detector')}
        description={t(
          'verify.forbidden.description',
          'The detector of this installation is limited to approved users. Ask your administrator for access.'
        )}
      />
    );
  } else {
    body = (
      <div className="space-y-6">
        <section
          aria-labelledby="verify-input-heading"
          className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 sm:p-6"
        >
          <h2
            id="verify-input-heading"
            className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('verify.input.heading', 'Content to check')}
          </h2>
          <VerifyContentForm
            maxUploadMB={info?.maxUploadMB}
            canUseTextDetection={info?.canUseTextDetection === true}
            busy={busy}
            onSubmit={handleVerify}
          />
          {verifyError && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-800 dark:text-red-200"
            >
              {verifyError}
            </p>
          )}
        </section>

        <section aria-labelledby="verify-result-heading" className="space-y-4">
          <h2 id="verify-result-heading" className="sr-only">
            {t('verify.result.heading', 'Result')}
          </h2>
          {/* Polite live region: announces "Checking…" and then the verdict. */}
          <div aria-live="polite" aria-atomic="true">
            {busy && <p className="sr-only">{t('verify.input.checking', 'Checking…')}</p>}
            {outcome?.result && <VerdictSummary result={outcome.result} />}
          </div>
          {outcome?.result && (
            <VerificationResult
              outcome={outcome}
              onDownloadReport={handleDownloadReport}
              downloadError={downloadError}
            />
          )}
        </section>

        <SignedReportCheck />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-2 text-gray-900 dark:text-gray-100">
            {logoUrl ? (
              <img
                src={buildAssetUrl(logoUrl)}
                alt={getLocalizedContent(uiConfig.header.logo.alt, currentLanguage) || 'Logo'}
                className="h-7 w-7 flex-none object-contain"
              />
            ) : (
              <IHubLogo size={28} />
            )}
            <BrandTitle
              uiConfig={uiConfig}
              currentLanguage={currentLanguage}
              className="truncate"
            />
          </Link>
          <span aria-hidden="true" className="text-gray-300 dark:text-gray-600">
            /
          </span>
          <span className="truncate text-sm font-medium text-gray-600 dark:text-gray-300">
            {pageTitle}
          </span>
          <Link
            to="/"
            className="ml-auto hidden items-center gap-1 whitespace-nowrap text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300 sm:inline-flex"
          >
            {t('verify.openApp', 'Open iHub Apps')}
            <Icon name="arrow-right" size="sm" />
          </Link>
        </div>
      </header>

      <main id="main-content" className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t('verify.heading', 'Check content for AI markings')}
        </h1>
        <p className="mt-2 mb-6 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'verify.intro',
            'Find out whether a file or a text carries a marking that identifies it as generated by AI (EU AI Act, Art. 50) — a signed C2PA manifest, an invisible watermark, a text signpost or a provenance record of this installation.'
          )}
        </p>
        {body}
      </main>
    </div>
  );
}

export default VerifyPage;
