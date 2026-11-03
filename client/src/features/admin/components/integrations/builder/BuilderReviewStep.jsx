// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { approvalModeLabel } from '../../ToolApprovalFields';
import { sourceText } from './BuilderSourceStep';

function localizedText(value, language) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value[language] || value.en || Object.values(value).find(Boolean) || '';
}

/**
 * Step 5 of the integration builder: what will be saved — the definition
 * `custom/<id>` and the installation `<id>`, the source, the sign-in and
 * every action with its side effect, data flow and approval.
 *
 * @param {Object} props
 * @param {Object} props.draft
 * @returns {JSX.Element}
 */
function BuilderReviewStep({ draft }) {
  const { t, i18n } = useTranslation();
  const [sourceLabel] = sourceText(t, draft.source);
  const auth = draft.auth || { mode: 'none' };
  const rows = [
    [t('admin.integrationBuilder.basics.name', 'Name'), localizedText(draft.name, i18n.language)],
    [t('admin.integrationBuilder.basics.instanceId', 'ID'), draft.instanceId],
    [
      t('admin.integrationBuilder.review.definition', 'Definition'),
      draft.definitionId || `custom/${draft.instanceId}`
    ],
    [t('admin.integrationBuilder.source.label', 'Where the actions come from'), sourceLabel],
    [
      t('admin.integrationBuilder.auth.mode.label', 'Sign-in'),
      auth.mode === 'service-account'
        ? `${t('admin.integrationBuilder.review.serviceAccount', 'Service account')} (${auth.credentialRef || '—'})`
        : auth.mode === 'oauth-user'
          ? t('admin.integrationBuilder.review.oauthUser', 'Per-user OAuth')
          : t('admin.integrationBuilder.review.none', 'None')
    ],
    [
      t('admin.integrationBuilder.actions.approvalDefault', 'Approval for every action'),
      draft.approvalDefault
        ? approvalModeLabel(t, draft.approvalDefault)
        : t('admin.toolApproval.inheritPlatform', 'As the platform default')
    ]
  ];

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-medium text-gray-700 dark:text-gray-300">{label}</dt>
            <dd className="sm:col-span-2 text-gray-900 dark:text-gray-100 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <caption className="text-left font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('admin.integrationBuilder.review.actions', 'Actions ({{count}})', {
              count: (draft.actions || []).length
            })}
          </caption>
          <thead>
            <tr className="text-left text-gray-600 dark:text-gray-400">
              <th scope="col" className="py-1 pr-4">
                {t('admin.integrationBuilder.action.name', 'Action name')}
              </th>
              <th scope="col" className="py-1 pr-4">
                {t('admin.toolApproval.sideEffect', 'Side effect')}
              </th>
              <th scope="col" className="py-1 pr-4">
                {t('admin.toolApproval.dataFlowLabel', 'Data flow')}
              </th>
              <th scope="col" className="py-1 pr-4">
                {t('admin.integrationBuilder.action.approval', 'Approval')}
              </th>
              <th scope="col" className="py-1">
                {t('admin.integrationBuilder.review.offered', 'Offered')}
              </th>
            </tr>
          </thead>
          <tbody className="text-gray-900 dark:text-gray-100">
            {(draft.actions || []).map(action => (
              <tr key={action.name} className="border-t border-gray-200 dark:border-gray-700">
                <td className="py-1 pr-4 font-mono">
                  {action.toolId || `${draft.instanceId}__${action.name}`}
                </td>
                <td className="py-1 pr-4">
                  {t(`admin.integrationCatalog.sideEffect.${action.sideEffect}`, action.sideEffect)}
                </td>
                <td className="py-1 pr-4">
                  {t(`admin.toolApproval.dataFlow.${action.dataFlow}`, action.dataFlow)}
                </td>
                <td className="py-1 pr-4">
                  {action.approval
                    ? approvalModeLabel(t, action.approval)
                    : t('admin.integrationBuilder.action.approvalInherit', 'As the integration')}
                </td>
                <td className="py-1">
                  {action.enabled === false ? t('common.no', 'No') : t('common.yes', 'Yes')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default BuilderReviewStep;
