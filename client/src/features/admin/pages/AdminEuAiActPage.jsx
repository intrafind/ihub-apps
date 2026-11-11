// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import AcknowledgementsCard from '../components/euAiAct/AcknowledgementsCard';
import ConfigCheckCard from '../components/euAiAct/ConfigCheckCard';
import ProvenanceSettingsCard from '../components/euAiAct/ProvenanceSettingsCard';
import VerificationCard from '../components/euAiAct/VerificationCard';
import WatermarkKeysCard from '../components/euAiAct/WatermarkKeysCard';
import useEuAiActStatus from '../hooks/useEuAiActStatus';

/**
 * `/admin/eu-ai-act`: one page for the EU AI Act Art. 50 duties. Five cards:
 * the configuration check, acknowledgements, watermark keys (with detector and
 * self-test), provenance settings and verification. Each card loads and fails on its own.
 */
function AdminEuAiActPage() {
  const { t } = useTranslation();
  const { status, loading, checking, error, reload } = useEuAiActStatus();

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
        <ConfigCheckCard
          status={status}
          loading={loading}
          error={error}
          checking={checking}
          onRecheck={reload}
        />
        <AcknowledgementsCard acknowledgements={status?.acknowledgements} onChanged={reload} />
        <WatermarkKeysCard statusModels={status?.models} onChanged={reload} />
        <ProvenanceSettingsCard onSaved={reload} />
        <VerificationCard maxFileBytes={status?.provenance?.media?.maxVerifyBytes} />
      </div>
    </div>
  );
}

export default AdminEuAiActPage;
