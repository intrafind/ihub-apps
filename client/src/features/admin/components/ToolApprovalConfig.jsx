// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { ApprovalModeSelect } from './ToolApprovalFields';

/**
 * The platform's tool approval defaults (`platform.json` → `toolApproval.defaults`)
 * from what the form holds: empty selects are left out, and with nothing set the
 * block is removed (approval is opt-in).
 *
 * @param {{default?: string, internal?: string, external?: string}} form
 * @returns {{defaults: Object}|null}
 */
export function toolApprovalFromForm(form) {
  const defaults = {};
  for (const key of ['default', 'internal', 'external']) {
    if (form?.[key]) defaults[key] = form[key];
  }
  return Object.keys(defaults).length ? { defaults } : null;
}

/**
 * Admin → Security → Tool approval (#2945): the platform defaults that decide
 * whether a person approves a model's tool call before it runs. Installations,
 * tools, actions and apps can only tighten these.
 */
function ToolApprovalConfig() {
  const { t } = useTranslation();
  const [form, setForm] = useState({ default: '', internal: '', external: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
        const defaults = response.data?.toolApproval?.defaults || {};
        setForm({
          default: defaults.default || '',
          internal: defaults.internal || '',
          external: defaults.external || ''
        });
      } catch (error) {
        setMessage({
          type: 'error',
          text:
            error.message ||
            t('admin.toolApproval.loadError', 'The tool approval settings could not be loaded.')
        });
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [t]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      // Only the approval block: the save route keeps every section the body
      // leaves out, while the GET answer it would otherwise echo back has
      // fields removed (a proxy JWT provider's `jwkUrl`), which a full-body
      // save would erase.
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        body: { toolApproval: toolApprovalFromForm(form) }
      });
      setMessage({
        type: 'success',
        text: t('admin.toolApproval.saved', 'Tool approval settings saved.')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message ||
          t('admin.toolApproval.saveError', 'The tool approval settings could not be saved.')
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Icon name="loader" className="h-6 w-6 animate-spin text-primary-600" />
      </div>
    );
  }

  const set = key => mode => setForm(prev => ({ ...prev, [key]: mode || '' }));

  return (
    <div className="space-y-6" data-testid="tool-approval-config">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          {t('admin.toolApproval.title', 'Tool approval')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.toolApproval.description',
            'Decide when a person has to approve a tool call before it runs. A read on an external system can carry internal information out, so external tools can be stricter. Integrations, tools, their actions and apps can only make this stricter, never looser. Nothing is asked until you set a mode here or on an integration or tool.'
          )}
        </p>
      </div>

      {message && (
        <div
          role={message.type === 'error' ? 'alert' : 'status'}
          className={`rounded-md p-3 text-sm ${
            message.type === 'success'
              ? 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300'
              : 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <ApprovalModeSelect
          label={t('admin.toolApproval.platformDefault', 'All tools')}
          value={form.default}
          inheritLabel={approvalNever(t)}
          modes={['writes', 'always']}
          onChange={set('default')}
          help={t(
            'admin.toolApproval.platformDefaultHelp',
            'Applies where no data flow rule is set.'
          )}
        />
        <ApprovalModeSelect
          label={t('admin.toolApproval.platformInternal', 'Internal tools')}
          value={form.internal}
          inheritLabel={t('admin.toolApproval.sameAsAll', 'Same as all tools')}
          onChange={set('internal')}
          help={t(
            'admin.toolApproval.platformInternalHelp',
            "Tools that stay inside your systems (iHub's own tools, internal integrations)."
          )}
        />
        <ApprovalModeSelect
          label={t('admin.toolApproval.platformExternal', 'External tools')}
          value={form.external}
          inheritLabel={t('admin.toolApproval.sameAsAll', 'Same as all tools')}
          onChange={set('external')}
          help={t(
            'admin.toolApproval.platformExternalHelp',
            'Remote MCP servers, A2A agents and integrations whose data leaves your systems.'
          )}
        />
      </div>

      <div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
        </button>
      </div>
    </div>
  );
}

function approvalNever(t) {
  return t('admin.toolApproval.mode.never', 'Never ask');
}

export default ToolApprovalConfig;
