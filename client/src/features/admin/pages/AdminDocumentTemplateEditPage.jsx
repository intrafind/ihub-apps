// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { saveBlobAs } from '../../../utils/externalNavigation';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import AdminLoadError from '../components/AdminLoadError';
import AdminPageSkeleton from '../components/AdminPageSkeleton';
import TemplateFileSlot from '../components/document-templates/TemplateFileSlot';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../components/people-directories/formStyles';
import {
  createDocumentTemplate,
  fetchDocumentTemplate,
  fetchDocumentTemplateFile,
  fetchDocumentTemplateSample,
  removeDocumentTemplateFile,
  saveDocumentTemplate,
  uploadDocumentTemplateFile
} from '../../../api/documentTemplatesAdminApi';
import { getAdminApiErrorMessage } from '../../../api/adminApi';
import {
  FONT_FACES,
  SLIDE_KINDS,
  cleanTemplate,
  emptyTemplate,
  fontChoices,
  normalizeTemplate,
  validateTemplate
} from '../utils/documentTemplates';

function Section({ title, description, children }) {
  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {description && (
        <p className="mt-1 mb-4 text-sm text-gray-600 dark:text-gray-400">{description}</p>
      )}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, help, error, children }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      {children(id)}
      {help && <p className={HELP_CLASS}>{help}</p>}
      {error && (
        <p className="mt-1 text-xs text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ColorField({ label, value, onChange, error }) {
  return (
    <Field label={label} error={error}>
      {id => (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={label}
            value={/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000'}
            onChange={event => onChange(event.target.value)}
            className="h-9 w-12 rounded-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
          />
          <input
            id={id}
            className={`${INPUT_CLASS} font-mono`}
            value={value || ''}
            placeholder="#e30613"
            onChange={event => onChange(event.target.value)}
          />
        </div>
      )}
    </Field>
  );
}

const SELECT_CLASS = INPUT_CLASS;

/**
 * Admin → Document templates → one template
 * (`/admin/document-templates/:templateId`, `new` for a new one).
 *
 * Settings are edited as a draft and saved together; files (logo, fonts,
 * letterhead, Word and PowerPoint templates) are uploaded one by one and
 * saved at once — with pending changes saved first, so an upload never
 * loses them. A new template is created with its name first; files can be
 * added after that.
 */
export default function AdminDocumentTemplateEditPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { templateId } = useParams();
  const isNew = templateId === 'new';
  const [draft, setDraft] = useState(() => (isNew ? emptyTemplate() : null));
  const [saved, setSaved] = useState(null);
  const [files, setFiles] = useState({});
  const [loadError, setLoadError] = useState(null);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busySlot, setBusySlot] = useState(null);
  const [preview, setPreview] = useState({ url: null, loading: false });
  const [logoUrl, setLogoUrl] = useState(null);
  const [newFont, setNewFont] = useState('');
  const [errors, setErrors] = useState({});
  const previewUrlRef = useRef(null);
  const logoUrlRef = useRef(null);

  const replaceUrl = (ref, setter, url) => {
    if (ref.current) URL.revokeObjectURL(ref.current);
    ref.current = url;
    setter(url);
  };

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (logoUrlRef.current) URL.revokeObjectURL(logoUrlRef.current);
    },
    []
  );

  const loadLogo = useCallback(async template => {
    if (!template?.brand?.logo) {
      replaceUrl(logoUrlRef, setLogoUrl, null);
      return;
    }
    try {
      const blob = await fetchDocumentTemplateFile(template.id, 'logo');
      replaceUrl(logoUrlRef, setLogoUrl, URL.createObjectURL(blob));
    } catch {
      replaceUrl(logoUrlRef, setLogoUrl, null);
    }
  }, []);

  const apply = useCallback(
    response => {
      const template = normalizeTemplate(response.template);
      setDraft(template);
      setSaved(template);
      if (response.files) setFiles(response.files);
      void loadLogo(template);
    },
    [loadLogo]
  );

  const load = useCallback(async () => {
    if (isNew) return;
    try {
      apply(await fetchDocumentTemplate(templateId));
      setLoadError(null);
    } catch (error) {
      setLoadError(getAdminApiErrorMessage(error));
    }
  }, [apply, isNew, templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = draft && saved && JSON.stringify(draft) !== JSON.stringify(saved);

  const update = (section, key, value) =>
    setDraft(current =>
      section
        ? { ...current, [section]: { ...current[section], [key]: value } }
        : { ...current, [key]: value }
    );

  const save = async () => {
    const problems = validateTemplate(draft, t);
    setErrors(problems);
    if (Object.keys(problems).length) {
      setMessage({
        type: 'error',
        text: t('admin.documentTemplates.edit.fixErrors', 'Fix the marked fields first.')
      });
      return false;
    }
    setSaving(true);
    setMessage(null);
    try {
      if (isNew) {
        const response = await createDocumentTemplate(cleanTemplate(draft));
        navigate(`/admin/document-templates/${encodeURIComponent(response.template.id)}`, {
          replace: true
        });
        return true;
      }
      apply(await saveDocumentTemplate(draft.id, cleanTemplate(draft)));
      setMessage({
        type: 'success',
        text: t('admin.documentTemplates.edit.saved', 'Template saved.')
      });
      return true;
    } catch (error) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(error) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const upload = async (slot, file, font) => {
    if (dirty && !(await save())) return;
    setBusySlot(font ? `${slot}:${font.family}:${font.face}` : slot);
    setMessage(null);
    try {
      apply(await uploadDocumentTemplateFile(draft.id, slot, file, font));
      setMessage({
        type: 'success',
        text: t('admin.documentTemplates.files.uploaded', '"{{name}}" uploaded.', {
          name: file.name
        })
      });
    } catch (error) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(error) });
    } finally {
      setBusySlot(null);
    }
  };

  const remove = async (slot, font) => {
    if (dirty && !(await save())) return;
    setBusySlot(font ? `${slot}:${font.family}:${font.face}` : slot);
    setMessage(null);
    try {
      apply(await removeDocumentTemplateFile(draft.id, slot, font));
    } catch (error) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(error) });
    } finally {
      setBusySlot(null);
    }
  };

  const sample = async format => {
    if (dirty && !(await save())) return;
    if (format === 'png') setPreview(current => ({ ...current, loading: true }));
    else setBusySlot(`sample:${format}`);
    try {
      const blob = await fetchDocumentTemplateSample(draft.id, format, i18n.language);
      if (format === 'png') {
        replaceUrl(
          previewUrlRef,
          url => setPreview({ url, loading: false }),
          URL.createObjectURL(blob)
        );
      } else {
        saveBlobAs(blob, `${draft.id}-sample.${format}`);
      }
    } catch (error) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(error) });
      if (format === 'png') setPreview(current => ({ ...current, loading: false }));
    } finally {
      setBusySlot(null);
    }
  };

  if (loadError) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AdminLoadError
          title={t('admin.documentTemplates.edit.loadError', 'The template could not be loaded')}
          message={loadError}
          action={{ label: t('common.retry', 'Retry'), onClick: load }}
        />
      </div>
    );
  }
  if (!draft) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AdminPageSkeleton rows={4} />
      </div>
    );
  }

  const name = getLocalizedContent(draft.name, i18n.language) || draft.id;
  const filesDisabled = isNew;
  const pptxInfo = files.powerpointTemplate;
  const wordInfo = files.wordTemplate;
  const fonts = fontChoices(draft);
  const fontListId = 'document-template-fonts';

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <AdminBreadcrumb
        crumbs={[
          {
            label: t('admin.documentTemplates.title', 'Document templates'),
            href: '/admin/document-templates'
          },
          { label: isNew ? t('admin.documentTemplates.edit.new', 'New template') : name }
        ]}
      />
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {isNew ? t('admin.documentTemplates.edit.new', 'New template') : name}
        </h1>
        <div className="flex gap-2">
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={() => navigate('/admin/document-templates')}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={PRIMARY_BUTTON_CLASS}
            onClick={save}
            disabled={saving || (!isNew && !dirty)}
          >
            {saving
              ? t('common.saving', 'Saving…')
              : isNew
                ? t('common.create', 'Create')
                : t('common.save', 'Save')}
          </button>
        </div>
      </div>

      {message && (
        <div
          role={message.type === 'error' ? 'alert' : 'status'}
          className={`${message.type === 'error' ? CALLOUT_CLASS.danger : CALLOUT_CLASS.success} mb-6`}
        >
          {message.text}
        </div>
      )}

      <datalist id={fontListId}>
        {fonts.map(font => (
          <option key={font} value={font} />
        ))}
      </datalist>

      <div className="space-y-6">
        <Section title={t('admin.documentTemplates.edit.general', 'General')}>
          <Field
            label={t('admin.documentTemplates.edit.id', 'ID')}
            help={t(
              'admin.documentTemplates.edit.idHelp',
              'Lower-case letters, digits and "-". Apps refer to the template by it; it cannot be changed later.'
            )}
            error={errors.id}
          >
            {id => (
              <input
                id={id}
                className={`${INPUT_CLASS} font-mono`}
                value={draft.id}
                disabled={!isNew}
                onChange={event => update(null, 'id', event.target.value.toLowerCase())}
              />
            )}
          </Field>
          <DynamicLanguageEditor
            label={t('admin.documentTemplates.edit.name', 'Name')}
            value={draft.name}
            onChange={value => update(null, 'name', value)}
            required
            error={errors.name}
          />
          <DynamicLanguageEditor
            label={t('admin.documentTemplates.edit.description', 'Description')}
            value={draft.description}
            onChange={value => update(null, 'description', value)}
          />
          <div className="flex flex-col gap-2">
            <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              <input
                type="checkbox"
                className={CHECKBOX_CLASS}
                checked={draft.enabled !== false}
                onChange={event => update(null, 'enabled', event.target.checked)}
              />
              {t('admin.documentTemplates.edit.enabled', 'Enabled')}
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              <input
                type="checkbox"
                className={CHECKBOX_CLASS}
                checked={Boolean(draft.default)}
                onChange={event => update(null, 'default', event.target.checked)}
              />
              {t(
                'admin.documentTemplates.edit.default',
                'Default template — used by every app that does not name one of its own'
              )}
            </label>
          </div>
        </Section>

        {isNew && (
          <p className={CALLOUT_CLASS.info}>
            {t(
              'admin.documentTemplates.edit.createFirst',
              'Create the template first; then you can set its colours and fonts and upload your logo, letterhead and Office templates.'
            )}
          </p>
        )}

        {!isNew && (
          <>
            <Section
              title={t('admin.documentTemplates.edit.brand', 'Brand')}
              description={t(
                'admin.documentTemplates.edit.brandHelp',
                'Colours, fonts and logo for every format. A Word or PowerPoint template below takes precedence for its own format.'
              )}
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <ColorField
                  label={t('admin.documentTemplates.edit.primaryColor', 'Primary colour')}
                  value={draft.brand.primaryColor}
                  onChange={value => update('brand', 'primaryColor', value)}
                  error={errors.primaryColor}
                />
                <ColorField
                  label={t('admin.documentTemplates.edit.accentColor', 'Accent colour')}
                  value={draft.brand.accentColor}
                  onChange={value => update('brand', 'accentColor', value)}
                  error={errors.accentColor}
                />
                <ColorField
                  label={t('admin.documentTemplates.edit.textColor', 'Text colour')}
                  value={draft.brand.textColor}
                  onChange={value => update('brand', 'textColor', value)}
                  error={errors.textColor}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field
                  label={t('admin.documentTemplates.edit.headingFont', 'Heading font')}
                  help={t(
                    'admin.documentTemplates.edit.fontHelp',
                    '"sans", "serif", an uploaded font, or a font installed on your computers (Word, PowerPoint).'
                  )}
                >
                  {id => (
                    <input
                      id={id}
                      list={fontListId}
                      className={INPUT_CLASS}
                      value={draft.brand.headingFont || ''}
                      onChange={event => update('brand', 'headingFont', event.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('admin.documentTemplates.edit.bodyFont', 'Body font')}>
                  {id => (
                    <input
                      id={id}
                      list={fontListId}
                      className={INPUT_CLASS}
                      value={draft.brand.bodyFont || ''}
                      onChange={event => update('brand', 'bodyFont', event.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('admin.documentTemplates.edit.fontSize', 'Body size (pt)')}>
                  {id => (
                    <input
                      id={id}
                      type="number"
                      min={7}
                      max={16}
                      step={0.5}
                      className={INPUT_CLASS}
                      value={draft.brand.fontSize ?? ''}
                      onChange={event =>
                        update(
                          'brand',
                          'fontSize',
                          event.target.value === '' ? undefined : Number(event.target.value)
                        )
                      }
                    />
                  )}
                </Field>
              </div>
              <Field
                label={t('admin.documentTemplates.edit.companyName', 'Company name')}
                help={t(
                  'admin.documentTemplates.edit.companyHelp',
                  'Author of documents without one, and {company} in headers and footers.'
                )}
              >
                {id => (
                  <input
                    id={id}
                    className={INPUT_CLASS}
                    value={draft.brand.companyName || ''}
                    onChange={event => update('brand', 'companyName', event.target.value)}
                  />
                )}
              </Field>
              <TemplateFileSlot
                label={t('admin.documentTemplates.files.logo', 'Logo')}
                help={t(
                  'admin.documentTemplates.files.logoHelp',
                  'PNG (with transparency) or JPEG, at least 600 pixels wide.'
                )}
                accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                fileName={draft.brand.logo}
                busy={busySlot === 'logo'}
                disabled={filesDisabled}
                onUpload={file => upload('logo', file)}
                onRemove={() => remove('logo')}
              >
                {logoUrl && (
                  <img
                    src={logoUrl}
                    alt={t('admin.documentTemplates.files.logoPreview', 'Logo preview')}
                    className="mt-3 max-h-16 max-w-xs rounded-sm border border-gray-200 dark:border-gray-700 bg-white p-1"
                  />
                )}
              </TemplateFileSlot>
            </Section>

            <Section
              title={t('admin.documentTemplates.edit.fonts', 'Fonts for PDFs')}
              description={t(
                'admin.documentTemplates.edit.fontsHelp',
                'PDFs embed their fonts. Upload your brand fonts as .ttf or .otf (one file per style) and use their family name above. Word and PowerPoint files name the font; it must be installed on the computers that open them. Check that your font licence allows embedding.'
              )}
            >
              {draft.fonts.map(font => (
                <div key={font.family} className="space-y-2">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {font.family}
                  </h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {FONT_FACES.map(face => (
                      <TemplateFileSlot
                        key={face}
                        label={t(`admin.documentTemplates.fonts.${face}`, face)}
                        accept=".ttf,.otf"
                        fileName={font[face]}
                        busy={busySlot === `font:${font.family}:${face}`}
                        disabled={face !== 'normal' && !font.normal}
                        onUpload={file => upload('font', file, { family: font.family, face })}
                        onRemove={() => remove('font', { family: font.family, face })}
                      />
                    ))}
                  </div>
                </div>
              ))}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <Field label={t('admin.documentTemplates.fonts.newFamily', 'New font family')}>
                  {id => (
                    <input
                      id={id}
                      className={INPUT_CLASS}
                      value={newFont}
                      placeholder="Frutiger"
                      onChange={event => setNewFont(event.target.value)}
                    />
                  )}
                </Field>
                <TemplateFileSlot
                  label={t('admin.documentTemplates.fonts.normal', 'Regular')}
                  accept=".ttf,.otf"
                  busy={busySlot === `font:${newFont}:normal`}
                  disabled={!newFont.trim()}
                  onUpload={async file => {
                    await upload('font', file, { family: newFont.trim(), face: 'normal' });
                    setNewFont('');
                  }}
                />
              </div>
            </Section>

            <Section
              title={t('admin.documentTemplates.edit.page', 'Page, header and footer')}
              description={t(
                'admin.documentTemplates.edit.pageHelp',
                'For PDF and Word documents without a Word template. Placeholders: {title}, {date}, {page}, {pages}, {company}. An empty header or footer means none.'
              )}
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t('admin.documentTemplates.edit.pageSize', 'Page size')}>
                  {id => (
                    <select
                      id={id}
                      className={SELECT_CLASS}
                      value={draft.document.pageSize || ''}
                      onChange={event =>
                        update('document', 'pageSize', event.target.value || undefined)
                      }
                    >
                      <option value="">
                        {t('admin.documentTemplates.edit.notSet', 'Not set')}
                      </option>
                      {['A4', 'LETTER', 'LEGAL', 'A3', 'A5'].map(size => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label={t('admin.documentTemplates.edit.orientation', 'Orientation')}>
                  {id => (
                    <select
                      id={id}
                      className={SELECT_CLASS}
                      value={draft.document.orientation || ''}
                      onChange={event =>
                        update('document', 'orientation', event.target.value || undefined)
                      }
                    >
                      <option value="">
                        {t('admin.documentTemplates.edit.notSet', 'Not set')}
                      </option>
                      <option value="portrait">
                        {t('admin.documentTemplates.edit.portrait', 'Portrait')}
                      </option>
                      <option value="landscape">
                        {t('admin.documentTemplates.edit.landscape', 'Landscape')}
                      </option>
                    </select>
                  )}
                </Field>
                <Field
                  label={t('admin.documentTemplates.edit.margins', 'Margins (pt)')}
                  help={t(
                    'admin.documentTemplates.edit.marginsHelp',
                    'Left, top, right, bottom. With a letterhead, keep the text clear of its logo and address block.'
                  )}
                >
                  {id => (
                    <div className="grid grid-cols-4 gap-1">
                      {[0, 1, 2, 3].map(index => (
                        <input
                          key={index}
                          id={index === 0 ? id : undefined}
                          type="number"
                          min={18}
                          max={200}
                          aria-label={
                            [
                              t('admin.documentTemplates.edit.marginLeft', 'Left'),
                              t('admin.documentTemplates.edit.marginTop', 'Top'),
                              t('admin.documentTemplates.edit.marginRight', 'Right'),
                              t('admin.documentTemplates.edit.marginBottom', 'Bottom')
                            ][index]
                          }
                          className={INPUT_CLASS}
                          value={draft.document.margins?.[index] ?? ''}
                          onChange={event => {
                            const margins = [...(draft.document.margins || [56, 70, 56, 70])];
                            margins[index] =
                              event.target.value === '' ? NaN : Number(event.target.value);
                            update('document', 'margins', margins);
                          }}
                        />
                      ))}
                    </div>
                  )}
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('admin.documentTemplates.edit.header', 'Header')}>
                  {id => (
                    <input
                      id={id}
                      className={INPUT_CLASS}
                      value={draft.document.header ?? ''}
                      placeholder="{title}"
                      onChange={event => update('document', 'header', event.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('admin.documentTemplates.edit.footer', 'Footer')}>
                  {id => (
                    <input
                      id={id}
                      className={INPUT_CLASS}
                      value={draft.document.footer ?? ''}
                      placeholder="{company} · Confidential"
                      onChange={event => update('document', 'footer', event.target.value)}
                    />
                  )}
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t('admin.documentTemplates.edit.logoPosition', 'Logo in the header')}>
                  {id => (
                    <select
                      id={id}
                      className={SELECT_CLASS}
                      value={draft.document.logoPosition || 'header-right'}
                      onChange={event => update('document', 'logoPosition', event.target.value)}
                    >
                      <option value="header-right">
                        {t('admin.documentTemplates.edit.logoRight', 'Right')}
                      </option>
                      <option value="header-left">
                        {t('admin.documentTemplates.edit.logoLeft', 'Left')}
                      </option>
                      <option value="none">
                        {t('admin.documentTemplates.edit.logoNone', 'None')}
                      </option>
                    </select>
                  )}
                </Field>
                <Field label={t('admin.documentTemplates.edit.logoWidth', 'Logo width (pt)')}>
                  {id => (
                    <input
                      id={id}
                      type="number"
                      min={20}
                      max={300}
                      className={INPUT_CLASS}
                      value={draft.document.logoWidth ?? ''}
                      placeholder="80"
                      onChange={event =>
                        update(
                          'document',
                          'logoWidth',
                          event.target.value === '' ? undefined : Number(event.target.value)
                        )
                      }
                    />
                  )}
                </Field>
                <div className="flex flex-col justify-end gap-2 pb-1">
                  <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                    <input
                      type="checkbox"
                      className={CHECKBOX_CLASS}
                      checked={draft.document.pageNumbers !== false}
                      onChange={event => update('document', 'pageNumbers', event.target.checked)}
                    />
                    {t('admin.documentTemplates.edit.pageNumbers', 'Page numbers')}
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                    <input
                      type="checkbox"
                      className={CHECKBOX_CLASS}
                      checked={draft.document.coverLogo !== false}
                      onChange={event => update('document', 'coverLogo', event.target.checked)}
                    />
                    {t('admin.documentTemplates.edit.coverLogo', 'Logo on cover pages')}
                  </label>
                </div>
              </div>
            </Section>

            <Section
              title={t('admin.documentTemplates.edit.pdf', 'PDF')}
              description={t(
                'admin.documentTemplates.edit.pdfHelp',
                'A letterhead PDF is printed under every page: its first page under the first page of a document, the "following pages" letterhead (or its second page) under the rest.'
              )}
            >
              <Field label={t('admin.documentTemplates.edit.theme', 'Base design')}>
                {id => (
                  <select
                    id={id}
                    className={SELECT_CLASS}
                    value={draft.pdf.theme || ''}
                    onChange={event => update('pdf', 'theme', event.target.value || undefined)}
                  >
                    <option value="">{t('admin.documentTemplates.edit.notSet', 'Not set')}</option>
                    <option value="default">Default</option>
                    <option value="professional">Professional</option>
                    <option value="minimal">Minimal</option>
                  </select>
                )}
              </Field>
              <TemplateFileSlot
                label={t('admin.documentTemplates.files.letterhead', 'Letterhead (first page)')}
                accept=".pdf,application/pdf"
                fileName={draft.pdf.letterhead}
                busy={busySlot === 'letterhead'}
                onUpload={file => upload('letterhead', file)}
                onRemove={() => remove('letterhead')}
              />
              <TemplateFileSlot
                label={t(
                  'admin.documentTemplates.files.letterheadFollowing',
                  'Letterhead (following pages)'
                )}
                accept=".pdf,application/pdf"
                fileName={draft.pdf.letterheadFollowing}
                busy={busySlot === 'letterheadFollowing'}
                onUpload={file => upload('letterheadFollowing', file)}
                onRemove={() => remove('letterheadFollowing')}
              />
            </Section>

            <Section
              title={t('admin.documentTemplates.edit.word', 'Word')}
              description={t(
                'admin.documentTemplates.edit.wordHelp',
                "Upload your Word template (.dotx or .docx). Its styles, headers, footers and page setup are used; the content is placed at a paragraph that holds only {{content}}, else after the template's text. {{fields}} are filled in.",
                {
                  content: '{{content}}',
                  fields: '{{title}}, {{subtitle}}, {{author}}, {{date}}, {{company}}'
                }
              )}
            >
              <TemplateFileSlot
                label={t('admin.documentTemplates.files.wordTemplate', 'Word template')}
                accept=".docx,.dotx"
                fileName={draft.docx.template}
                busy={busySlot === 'wordTemplate'}
                onUpload={file => upload('wordTemplate', file)}
                onRemove={() => remove('wordTemplate')}
              >
                {wordInfo && !wordInfo.error && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-gray-600 dark:text-gray-400">
                    <li>
                      {wordInfo.placeholders?.length
                        ? t('admin.documentTemplates.word.placeholders', 'Placeholders: {{list}}', {
                            list: wordInfo.placeholders.map(p => `{{${p}}}`).join(', ')
                          })
                        : t('admin.documentTemplates.word.noPlaceholders', 'No placeholders.')}
                    </li>
                    {!wordInfo.styles?.headings && (
                      <li>
                        {t(
                          'admin.documentTemplates.word.noHeadings',
                          'The template does not define Heading 1–3; headings use its theme fonts and colours.'
                        )}
                      </li>
                    )}
                  </ul>
                )}
                {wordInfo?.error && (
                  <p className={`${CALLOUT_CLASS.warning} mt-2`}>{wordInfo.error}</p>
                )}
              </TemplateFileSlot>
            </Section>

            <Section
              title={t('admin.documentTemplates.edit.powerpoint', 'PowerPoint')}
              description={t(
                'admin.documentTemplates.edit.powerpointHelp',
                'Upload your slide template (.potx or .pptx). Slides use its layouts, so titles, text, fonts, colours and logos come from it; sample slides in the file are not copied. Without a template, slides are made from the brand above.'
              )}
            >
              <TemplateFileSlot
                label={t('admin.documentTemplates.files.powerpointTemplate', 'PowerPoint template')}
                accept=".pptx,.potx"
                fileName={draft.pptx.template}
                busy={busySlot === 'powerpointTemplate'}
                onUpload={file => upload('powerpointTemplate', file)}
                onRemove={() => remove('powerpointTemplate')}
              >
                {pptxInfo?.error && (
                  <p className={`${CALLOUT_CLASS.warning} mt-2`}>{pptxInfo.error}</p>
                )}
              </TemplateFileSlot>
              {pptxInfo?.layouts && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {t('admin.documentTemplates.pptx.layouts', 'Layouts for each kind of slide')}
                  </h3>
                  <p className={HELP_CLASS}>
                    {t(
                      'admin.documentTemplates.pptx.layoutsHelp',
                      'Chosen from the layout types; change a choice if it does not fit. Slide size: {{size}}.',
                      { size: `${pptxInfo.slideSize?.aspectRatio}` }
                    )}
                  </p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    {SLIDE_KINDS.map(kind => (
                      <Field
                        key={kind}
                        label={t(`admin.documentTemplates.pptx.kinds.${kind}`, kind)}
                      >
                        {id => (
                          <select
                            id={id}
                            className={SELECT_CLASS}
                            value={draft.pptx.layouts?.[kind] || ''}
                            onChange={event =>
                              update('pptx', 'layouts', {
                                ...draft.pptx.layouts,
                                [kind]: event.target.value || undefined
                              })
                            }
                          >
                            <option value="">
                              {t('admin.documentTemplates.pptx.automatic', 'Automatic ({{name}})', {
                                name: pptxInfo.mapping?.[kind] || '—'
                              })}
                            </option>
                            {[...new Set(pptxInfo.layouts.map(layout => layout.name))].map(
                              layoutName => (
                                <option key={layoutName} value={layoutName}>
                                  {layoutName}
                                </option>
                              )
                            )}
                          </select>
                        )}
                      </Field>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-3">
                <Field
                  label={t('admin.documentTemplates.edit.aspectRatio', 'Slide format')}
                  help={t(
                    'admin.documentTemplates.edit.aspectRatioHelp',
                    'Without a PowerPoint template.'
                  )}
                >
                  {id => (
                    <select
                      id={id}
                      className={SELECT_CLASS}
                      value={draft.pptx.aspectRatio || ''}
                      onChange={event =>
                        update('pptx', 'aspectRatio', event.target.value || undefined)
                      }
                    >
                      <option value="">
                        {t('admin.documentTemplates.edit.notSet', 'Not set')}
                      </option>
                      <option value="16:9">16:9</option>
                      <option value="4:3">4:3</option>
                    </select>
                  )}
                </Field>
                <Field label={t('admin.documentTemplates.edit.slideFooter', 'Slide footer')}>
                  {id => (
                    <input
                      id={id}
                      className={INPUT_CLASS}
                      value={draft.pptx.footer ?? ''}
                      placeholder="{company}"
                      onChange={event => update('pptx', 'footer', event.target.value)}
                    />
                  )}
                </Field>
                <div className="flex items-end pb-1">
                  <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                    <input
                      type="checkbox"
                      className={CHECKBOX_CLASS}
                      checked={draft.pptx.slideNumbers !== false}
                      onChange={event => update('pptx', 'slideNumbers', event.target.checked)}
                    />
                    {t('admin.documentTemplates.edit.slideNumbers', 'Slide numbers')}
                  </label>
                </div>
              </div>
            </Section>

            <Section
              title={t('admin.documentTemplates.edit.preview', 'Preview')}
              description={t(
                'admin.documentTemplates.edit.previewHelp',
                'Sample documents with the saved template. Pending changes are saved first.'
              )}
            >
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={SECONDARY_BUTTON_CLASS}
                  disabled={preview.loading}
                  onClick={() => sample('png')}
                >
                  <Icon
                    name={preview.loading ? 'refresh' : 'document-text'}
                    size="sm"
                    className={preview.loading ? 'animate-spin' : ''}
                  />
                  {t('admin.documentTemplates.preview.show', 'Show PDF page')}
                </button>
                {[
                  ['pdf', t('admin.documentTemplates.preview.pdf', 'Sample PDF')],
                  ['docx', t('admin.documentTemplates.preview.docx', 'Sample Word document')],
                  ['pptx', t('admin.documentTemplates.preview.pptx', 'Sample presentation')]
                ].map(([format, label]) => (
                  <button
                    key={format}
                    type="button"
                    className={SECONDARY_BUTTON_CLASS}
                    disabled={busySlot === `sample:${format}`}
                    onClick={() => sample(format)}
                  >
                    <Icon
                      name={busySlot === `sample:${format}` ? 'refresh' : 'download'}
                      size="sm"
                      className={busySlot === `sample:${format}` ? 'animate-spin' : ''}
                    />
                    {label}
                  </button>
                ))}
              </div>
              {preview.url && (
                <img
                  src={preview.url}
                  alt={t('admin.documentTemplates.preview.alt', 'First page of a sample PDF')}
                  className="max-w-md w-full rounded-sm border border-gray-200 dark:border-gray-700 shadow-sm"
                />
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
