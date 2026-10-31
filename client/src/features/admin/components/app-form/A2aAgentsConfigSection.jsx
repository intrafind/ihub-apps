// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import A2aAgentsSelector from '../A2aAgentsSelector';

/**
 * App editor section for remote A2A agents, enabled per app as a whole; their
 * tool ids are reported so the generic tools picker leaves them out. (MCP
 * servers are installed integrations and bound in the integrations section.)
 */
function A2aAgentsConfigSection({ selectedTools, onToolsChange, onRemoteToolIdsChange }) {
  const { t } = useTranslation();

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.a2aAgents.title', 'Remote A2A agents')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.a2aAgents.desc',
              'Choose the remote agents (Agent-to-Agent protocol) this app can delegate to. Users see each agent as a single entry in the chat.'
            )}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2">
          <A2aAgentsSelector
            selectedTools={selectedTools}
            onToolsChange={onToolsChange}
            onA2aToolIdsChange={onRemoteToolIdsChange}
          />
        </div>
      </div>
    </div>
  );
}

export default A2aAgentsConfigSection;
