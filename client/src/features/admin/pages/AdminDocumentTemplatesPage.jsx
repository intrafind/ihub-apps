// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { getLocalizedContent } from '../../../utils/localizeContent';
import AdminLoadError from '../components/AdminLoadError';
import AdminPageSkeleton from '../components/AdminPageSkeleton';
import {
  CALLOUT_CLASS,
  DANGER_BUTTON_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../components/people-directories/formStyles';
import {
  deleteDocumentTemplate,
  fetchDocumentTemplates
} from '../../../api/documentTemplatesAdminApi';
import { getAdminApiErrorMessage } from '../../../api/adminApi';

/** What a template customises, as badges. */
function templateParts(template, t) {
  const parts = [];
  if (template.brand?.logo) parts.push(t('admin.documentTemplates.parts.logo', 'Logo'));
  if (template.fonts?.length) parts.push(t('admin.documentTemplates.parts.fonts', 'Fonts'));
  if (template.pdf?.letterhead) {
    parts.push(t('admin.documentTemplates.parts.letterhead', 'Letterhead'));
  }
  if (template.docx?.template) {
    parts.push(t('admin.documentTemplates.parts.word', 'Word template'));
  }
  if (template.pptx?.template) {
    parts.push(t('admin.documentTemplates.parts.powerpoint', 'PowerPoint template'));
  }
  return parts;
}

function Swatch({ color }) {
  if (!color) return null;
  return (
    <span
      className="inline-block h-4 w-4 rounded-sm border border-gray-300 dark:border-gray-600"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}

/**
 * Admin → Customization → Document templates (`/admin/document-templates`).
 *
 * The corporate designs generated PDF, Word and PowerPoint files use. Each
 * template is edited on its own page; this one lists them, shows which is the
 * default, and deletes them.
 */
export default function AdminDocumentTemplatesPage() {
  const { t, i18n } = useTranslation();
  const [templates, setTemplates] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [message, setMessage] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    try {
      setTemplates(await fetchDocumentTemplates());
      setLoadError(null);
    } catch (error) {
      setLoadError(getAdminApiErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = template => getLocalizedContent(template.name, i18n.language) || template.id;

  const confirmDelete = async () => {
    const template = deleteTarget;
    setDeleteTarget(null);
    if (!template) return;
    try {
      await deleteDocumentTemplate(template.id);
      setMessage({
        type: 'success',
        text: t('admin.documentTemplates.list.deleted', '"{{name}}" deleted.', {
          name: nameOf(template)
        })
      });
      await load();
    } catch (error) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(error) });
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.documentTemplates.title', 'Document templates')}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
            {t(
              'admin.documentTemplates.subtitle',
              'Your corporate design for the PDF, Word and PowerPoint files iHub creates: colours, fonts, logo, letterhead, and your own Word and PowerPoint templates. The default template applies everywhere; an app can use a template of its own.'
            )}
          </p>
        </div>
        <Link
          to="/admin/document-templates/new"
          className={`${PRIMARY_BUTTON_CLASS} shrink-0 whitespace-nowrap self-start`}
        >
          <Icon name="plus" size="sm" />
          {t('admin.documentTemplates.list.add', 'Add template')}
        </Link>
      </div>

      {message && (
        <div
          role={message.type === 'error' ? 'alert' : 'status'}
          className={`${message.type === 'error' ? CALLOUT_CLASS.danger : CALLOUT_CLASS.success} mb-6`}
        >
          {message.text}
        </div>
      )}

      {loadError ? (
        <AdminLoadError
          framed={false}
          title={t(
            'admin.documentTemplates.list.loadError',
            'The document templates could not be loaded'
          )}
          message={loadError}
          action={{ label: t('common.retry', 'Retry'), onClick: load }}
        />
      ) : templates === null ? (
        <AdminPageSkeleton rows={2} hasHeader={false} />
      ) : templates.length === 0 ? (
        <div className={CALLOUT_CLASS.info}>
          {t(
            'admin.documentTemplates.list.empty',
            'No templates yet. Documents use the built-in design until you add one.'
          )}
        </div>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          {templates.map(template => (
            <li
              key={template.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/admin/document-templates/${encodeURIComponent(template.id)}`}
                    className="font-medium text-gray-900 dark:text-gray-100 hover:underline"
                  >
                    {nameOf(template)}
                  </Link>
                  <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                    {template.id}
                  </span>
                  {template.default && (
                    <span className="rounded-full bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 text-xs font-medium text-blue-800 dark:text-blue-200">
                      {t('admin.documentTemplates.list.default', 'Default')}
                    </span>
                  )}
                  {template.enabled === false && (
                    <span className="rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.documentTemplates.list.disabled', 'Disabled')}
                    </span>
                  )}
                </div>
                {getLocalizedContent(template.description, i18n.language) && (
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    {getLocalizedContent(template.description, i18n.language)}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <Swatch color={template.brand?.primaryColor} />
                  <Swatch color={template.brand?.accentColor} />
                  {templateParts(template, t).map(part => (
                    <span
                      key={part}
                      className="rounded-sm border border-gray-200 dark:border-gray-600 px-1.5 py-0.5"
                    >
                      {part}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Link
                  to={`/admin/document-templates/${encodeURIComponent(template.id)}`}
                  className={SECONDARY_BUTTON_CLASS}
                >
                  <Icon name="pencil" size="sm" />
                  {t('common.edit', 'Edit')}
                </Link>
                <button
                  type="button"
                  className={DANGER_BUTTON_CLASS}
                  onClick={() => setDeleteTarget(template)}
                  aria-label={t('admin.documentTemplates.list.deleteNamed', 'Delete {{name}}', {
                    name: nameOf(template)
                  })}
                >
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={t('admin.documentTemplates.list.deleteTitle', 'Delete template')}
        message={t(
          'admin.documentTemplates.list.deleteConfirm',
          'Delete "{{name}}" and its files? Apps that use it fall back to the default template.',
          { name: deleteTarget ? nameOf(deleteTarget) : '' }
        )}
        confirmLabel={t('common.delete', 'Delete')}
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={confirmDelete}
        onDeny={() => setDeleteTarget(null)}
      />
    </div>
  );
}
