// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import AiAcknowledgementSettingsCard from '../components/AiAcknowledgementSettingsCard';
import AiNoticeSettingsCard from '../components/AiNoticeSettingsCard';
import AcknowledgementsCard from '../components/euAiAct/AcknowledgementsCard';
import ConformityCard from '../components/euAiAct/ConformityCard';
import ConfigCheckCard from '../components/euAiAct/ConfigCheckCard';
import ProvenanceSettingsCard from '../components/euAiAct/ProvenanceSettingsCard';
import VerificationCard from '../components/euAiAct/VerificationCard';
import WatermarkKeysCard from '../components/euAiAct/WatermarkKeysCard';
import useEuAiActStatus from '../hooks/useEuAiActStatus';

/**
 * `/admin/eu-ai-act`: one page for the EU AI Act Art. 50 duties. Eight cards: the master
 * switch (all EU AI Act features on or off, with who, when and why), the configuration
 * check, the AI notice (first-turn notice and guardrail wording), the AI acknowledgement
 * settings, acknowledgements, watermark keys (with detector and self-test), provenance
 * settings and verification. Each card loads and fails on its own.
 */
function AdminEuAiActPage() {
  const { t } = useTranslation();
  const { hash } = useLocation();
  const { status, loading, checking, error, reload } = useEuAiActStatus();

  // A fix link of the configuration check names a card (`#ai-notice`); the router
  // does not scroll to it by itself.
  useEffect(() => {
    if (!hash) return;
    let id;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return; // A malformed fragment (`#%`) names no card.
    }
    document.getElementById(id)?.scrollIntoView?.({ block: 'start' });
  }, [hash]);
  // The master switch is off: the cards below are paused (read-only, explained).
  const paused = status?.conformity?.enabled === false;

  return (
    <div>
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.euAiAct.title', 'EU AI Act (Art. 50)')}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.euAiAct.description',
              'Is this installation set up for the transparency duties of Art. 50, can you operate what they require, and does it work? A green check means "configured as designed", not "legally compliant".'
            )}
          </p>
        </div>
      </div>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <ConformityCard
          conformity={status?.conformity || null}
          loading={loading}
          error={error}
          onReload={reload}
        />
        <ConfigCheckCard
          status={status}
          loading={loading}
          error={error}
          checking={checking}
          onRecheck={reload}
        />
        <AiNoticeSettingsCard onSaved={reload} />
        <AiAcknowledgementSettingsCard
          onSaved={reload}
          requiredVersion={status?.acknowledgements?.requiredVersion}
        />
        <AcknowledgementsCard
          acknowledgements={status?.acknowledgements}
          onChanged={reload}
          paused={paused}
        />
        <WatermarkKeysCard statusModels={status?.models} onChanged={reload} />
        <ProvenanceSettingsCard onSaved={reload} />
        <VerificationCard maxFileBytes={status?.provenance?.media?.maxVerifyBytes} />
      </div>
    </div>
  );
}

export default AdminEuAiActPage;
