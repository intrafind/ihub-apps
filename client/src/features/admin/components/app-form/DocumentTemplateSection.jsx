// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { fetchDocumentTemplates } from '../../../../api/documentTemplatesAdminApi';
import { getLocalizedContent } from '../../../../utils/localizeContent';

/**
 * The app's document template (`app.documentTemplate`): the corporate design
 * of every PDF, Word and PowerPoint file the app's skills create, and of its
 * PDF export. Without one, the default template applies.
 */
function DocumentTemplateSection({ app, onChange }) {
  const { t, i18n } = useTranslation();
  const selectId = useId();
  const [templates, setTemplates] = useState(null);

  useEffect(() => {
    let active = true;
    fetchDocumentTemplates()
      .then(list => {
        if (active) setTemplates(list);
      })
      .catch(() => {
        if (active) setTemplates([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const nameOf = template => getLocalizedContent(template.name, i18n.language) || template.id;
  const defaultTemplate = templates?.find(template => template.default && template.enabled);
  const selected = app.documentTemplate || '';
  const missing = selected && templates && !templates.some(template => template.id === selected);

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.documentTemplate', 'Document template')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.documentTemplateDesc',
              'The corporate design of the PDF, Word and PowerPoint files this app creates (skills "pdf", "docx", "pptx") and of its PDF export.'
            )}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0 space-y-2">
          <label
            htmlFor={selectId}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('admin.apps.edit.documentTemplate', 'Document template')}
          </label>
          <select
            id={selectId}
            value={selected}
            disabled={templates === null}
            onChange={event => {
              const next = { ...app, documentTemplate: event.target.value || undefined };
              if (!event.target.value) delete next.documentTemplate;
              onChange(next);
            }}
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500"
          >
            <option value="">
              {defaultTemplate
                ? t('admin.apps.edit.documentTemplateDefault', 'Default template ({{name}})', {
                    name: nameOf(defaultTemplate)
                  })
                : t(
                    'admin.apps.edit.documentTemplateNone',
                    'Built-in design (no default template)'
                  )}
            </option>
            {(templates || [])
              .filter(template => template.enabled !== false || template.id === selected)
              .map(template => (
                <option key={template.id} value={template.id}>
                  {nameOf(template)}
                </option>
              ))}
            {missing && <option value={selected}>{selected}</option>}
          </select>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {selected
              ? t(
                  'admin.apps.edit.documentTemplatePinned',
                  'Every document of this app uses this template; the model cannot choose another one.'
                )
              : t(
                  'admin.apps.edit.documentTemplateFree',
                  'The default template applies; the model may use another template when the user asks for it.'
                )}{' '}
            <Link
              to="/admin/document-templates"
              className="text-blue-700 dark:text-blue-300 underline"
            >
              {t('admin.apps.edit.documentTemplatesLink', 'Manage document templates')}
            </Link>
          </p>
          {missing && (
            <p className="text-xs text-amber-800 dark:text-amber-200" role="alert">
              {t(
                'admin.apps.edit.documentTemplateMissing',
                'The template "{{id}}" does not exist; the default template applies.',
                { id: selected }
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default DocumentTemplateSection;
