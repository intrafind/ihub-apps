// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../../shared/components/Icon';
import LoadingSpinner from '../../../../../shared/components/LoadingSpinner';
import { ApprovalModeSelect } from '../../ToolApprovalFields';
import { CALLOUT_CLASS, SECONDARY_BUTTON_CLASS } from '../../formStyles';
import { getAdminApiErrorMessage } from '../../../../../api/adminApi';
import { importBuilderActions } from '../../../../../api/integrationsAdminApi';
import BuilderActionCard from './BuilderActionCard';
import {
  actionsFromImport,
  draftForSave,
  emptyHttpAction,
  emptyScriptAction
} from './builderModel';

/**
 * Step 4 of the integration builder: the actions. An HTTP request or script
 * integration adds and removes its own; an OpenAPI integration has one per
 * picked operation; an MCP server's tools and an A2A agent's skills are
 * listed from the source (`tools/list`, the agent card), and the admin sets
 * their description, side effect, data flow and approval.
 *
 * @param {Object} props
 * @param {Object} props.draft
 * @param {(patch: Object) => void} props.onChange
 * @param {Object<string, {key: string, defaultValue: string}>} props.errors
 * @returns {JSX.Element}
 */
function BuilderActionsStep({ draft, onChange, errors }) {
  const { t } = useTranslation();
  const [listing, setListing] = useState(false);
  const [listResult, setListResult] = useState(null);
  const actions = draft.actions || [];
  const remote = draft.source === 'mcp' || draft.source === 'a2a';
  const addable = draft.source === 'http' || draft.source === 'script';

  const setActions = next => onChange({ actions: next });

  const list = async () => {
    setListing(true);
    setListResult(null);
    try {
      const saved = draftForSave(draft);
      const result = await importBuilderActions({
        kind: draft.source,
        source: saved[draft.source],
        auth: saved.auth
      });
      setListResult(result);
      if (result.actions?.length) setActions(actionsFromImport(result.actions, actions));
    } catch (err) {
      setListResult({ success: false, message: getAdminApiErrorMessage(err) });
    } finally {
      setListing(false);
    }
  };

  const add = () => {
    const names = actions.map(a => a.name);
    setActions([
      ...actions,
      draft.source === 'http' ? emptyHttpAction(names) : emptyScriptAction(names)
    ]);
  };

  return (
    <div className="space-y-5">
      <ApprovalModeSelect
        label={t('admin.integrationBuilder.actions.approvalDefault', 'Approval for every action')}
        value={draft.approvalDefault}
        onChange={approvalDefault => onChange({ approvalDefault })}
        inheritLabel={t('admin.toolApproval.inheritPlatform', 'As the platform default')}
        help={t(
          'admin.integrationBuilder.actions.approvalHelp',
          'Whether a person approves a call before it runs. An action can only be stricter; an app can tighten it further.'
        )}
      />

      {remote && (
        <div className="space-y-2">
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={list}
            disabled={listing}
          >
            {listing ? <LoadingSpinner size="sm" /> : <Icon name="refresh" size="sm" />}
            {draft.source === 'mcp'
              ? t('admin.integrationBuilder.actions.listTools', 'List the server’s tools')
              : t('admin.integrationBuilder.actions.listSkills', 'Read the agent’s skills')}
          </button>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {t(
              'admin.integrationBuilder.actions.remoteHelp',
              'The actions are whatever the source lists when it is called; settings made here apply to the names listed now and stay with them.'
            )}
          </p>
          {listResult && (
            <output
              className={`block ${listResult.success === false ? CALLOUT_CLASS.warning : CALLOUT_CLASS.success}`}
            >
              {listResult.message ||
                t('admin.integrationBuilder.actions.listed', '{{count}} action(s) listed.', {
                  count: listResult.actions?.length || 0
                })}
              {listResult.connectUrl && (
                <>
                  {' '}
                  {t(
                    'admin.integrationBuilder.actions.connectFirst',
                    'Save the integration and connect your own account to list its tools.'
                  )}
                </>
              )}
            </output>
          )}
        </div>
      )}

      {draft.source === 'openapi' && actions.length === 0 && (
        <p className={CALLOUT_CLASS.info}>
          {t(
            'admin.integrationBuilder.actions.pickOperations',
            'Pick operations of the OpenAPI document on the previous step.'
          )}
        </p>
      )}

      {errors.actions && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {t(errors.actions.key, errors.actions.defaultValue)}
        </p>
      )}

      <ul className="space-y-4">
        {actions.map((action, index) => (
          <BuilderActionCard
            key={`${index}-${action.operationId || ''}`}
            action={action}
            index={index}
            source={draft.source}
            errors={errors}
            onChange={next => setActions(actions.map((a, i) => (i === index ? next : a)))}
            onRemove={
              addable || draft.source === 'openapi'
                ? () => setActions(actions.filter((_, i) => i !== index))
                : undefined
            }
          />
        ))}
      </ul>

      {addable && (
        <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={add}>
          <Icon name="plus" size="sm" />
          {t('admin.integrationBuilder.actions.add', 'Add action')}
        </button>
      )}
    </div>
  );
}

export default BuilderActionsStep;
