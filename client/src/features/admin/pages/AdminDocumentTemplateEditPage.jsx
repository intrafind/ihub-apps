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
import TemplateFields from '../components/document-templates/TemplateFields';
import TemplateFileSlot from '../components/document-templates/TemplateFileSlot';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../components/formStyles';
import {
  createDocumentTemplate,
  fetchDocumentTemplate,
  fetchDocumentTemplateSample,
  readDocumentTemplateBrand,
  removeDocumentTemplateFile,
  saveDocumentTemplate,
  uploadDocumentTemplateFile
} from '../../../api/documentTemplatesAdminApi';
import { getAdminApiErrorMessage } from '../../../api/adminApi';
import {
  BUILT_IN_PLACEHOLDERS,
  DEFAULT_MARGINS,
  MARGIN_RANGE,
  SLIDE_KINDS,
  cleanTemplate,
  emptyTemplate,
  normalizeTemplate,
  validateTemplate
} from '../utils/documentTemplates';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import UnsavedChangesDialog from '../components/UnsavedChangesDialog';
import AdminSaveBar from '../components/AdminSaveBar';

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

/** Where a resolved brand value comes from, as text. */
function sourceText(source, t) {
  switch (source) {
    case 'template':
      return t('admin.documentTemplates.sources.template', 'Set on this page');
    case 'powerpoint':
      return t('admin.documentTemplates.sources.powerpoint', 'From the PowerPoint template');
    case 'word':
      return t('admin.documentTemplates.sources.word', 'From the Word template');
    default:
      return t('admin.documentTemplates.sources.default', 'Neutral default');
  }
}

/**
 * A colour: the picker and the hex field show what is set here, else the
 * colour the template's files give (the "resolved" one), so an empty field is
 * never a black swatch.
 */
function ColorField({ label, value, resolved, source, onChange, error }) {
  const { t } = useTranslation();
  const own = /^#[0-9a-f]{6}$/i.test(value || '');
  const shown = own ? value : /^#[0-9a-f]{6}$/i.test(resolved || '') ? resolved : '#000000';
  return (
    <Field label={label} error={error} help={own ? undefined : sourceText(source || 'default', t)}>
      {id => (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={label}
            value={shown.toLowerCase()}
            onChange={event => onChange(event.target.value)}
            className="h-9 w-12 shrink-0 cursor-pointer rounded-sm border border-admin-control-border dark:border-admin-control-border-dark bg-white dark:bg-gray-700 p-0.5"
          />
          <input
            id={id}
            className={`${INPUT_CLASS} font-mono`}
            value={value || ''}
            placeholder={resolved}
            onChange={event => onChange(event.target.value)}
          />
        </div>
      )}
    </Field>
  );
}

function Swatches({ colors }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {[...new Set(colors)].map(color => (
        <li key={color} className="flex items-center gap-1">
          <span
            className="inline-block h-5 w-5 rounded-sm border border-gray-300 dark:border-gray-600"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
          <code className="text-xs text-gray-700 dark:text-gray-300">{color}</code>
        </li>
      ))}
    </ul>
  );
}

/** The four margins of PDFs: what is set, else what the Word template (or the default) gives. */
function MarginFields({ margins, resolved, source, hasWord, error, onChange, onReset }) {
  const { t } = useTranslation();
  const baseId = useId();
  const shown = margins || resolved || DEFAULT_MARGINS;
  const labels = [
    t('admin.documentTemplates.edit.marginLeft', 'Left'),
    t('admin.documentTemplates.edit.marginTop', 'Top'),
    t('admin.documentTemplates.edit.marginRight', 'Right'),
    t('admin.documentTemplates.edit.marginBottom', 'Bottom')
  ];
  return (
    <div>
      <label htmlFor={`${baseId}-0`} className={LABEL_CLASS}>
        {t('admin.documentTemplates.edit.margins', 'Margins (pt)')}
      </label>
      <div className="grid max-w-md grid-cols-4 gap-2">
        {labels.map((label, index) => (
          <div key={label}>
            <input
              id={`${baseId}-${index}`}
              type="number"
              min={MARGIN_RANGE.min}
              max={MARGIN_RANGE.max}
              aria-label={label}
              className={INPUT_CLASS}
              value={Number.isFinite(shown[index]) ? shown[index] : ''}
              onChange={event => {
                const next = [...shown];
                next[index] = event.target.value === '' ? Number.NaN : Number(event.target.value);
                onChange(next);
              }}
            />
            <span className="mt-0.5 block text-center text-xs text-gray-600 dark:text-gray-400">
              {label}
            </span>
          </div>
        ))}
      </div>
      <p className={HELP_CLASS}>
        {margins
          ? t('admin.documentTemplates.edit.marginsOwn', 'Set on this page.')
          : `${sourceText(source, t)}.`}{' '}
        {t(
          'admin.documentTemplates.edit.marginsHelp',
          'Left, top, right, bottom, in points. They keep the text of a PDF clear of the page edges.'
        )}
      </p>
      {margins && (
        <button type="button" className={`${SECONDARY_BUTTON_CLASS} mt-2`} onClick={onReset}>
          {hasWord
            ? t('admin.documentTemplates.edit.marginsFromWord', "Use the Word template's margins")
            : t('admin.documentTemplates.edit.marginsDefault', 'Use the default margins')}
        </button>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** What was found in the Word template. */
function WordFindings({ info }) {
  const { t } = useTranslation();
  if (info.error) return <p className={`${CALLOUT_CLASS.warning} mt-2`}>{info.error}</p>;
  const builtIn = (info.placeholders || []).filter(name => BUILT_IN_PLACEHOLDERS.includes(name));
  const fields = info.customFields || [];
  const list = names => names.map(name => `{{${name}}}`).join(', ');
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-gray-600 dark:text-gray-400">
      <li>
        {info.contentPlaceholder
          ? t(
              'admin.documentTemplates.word.contentHere',
              'The content goes where the template has {{content}}.',
              { content: '{{content}}' }
            )
          : t(
              'admin.documentTemplates.word.contentAfter',
              'There is no {{content}} placeholder: the content goes after the template text. Put {{content}} in a paragraph of its own to choose the place.',
              { content: '{{content}}' }
            )}
      </li>
      <li>
        {info.tocPlaceholder
          ? t(
              'admin.documentTemplates.word.tocHere',
              'A table of contents goes where the template has {{toc}}.',
              { toc: '{{toc}}' }
            )
          : t(
              'admin.documentTemplates.word.tocNone',
              'No {{toc}} placeholder: a table of contents, when asked for, starts the content. Put {{toc}} in a paragraph of its own to choose the place.',
              { toc: '{{toc}}' }
            )}
      </li>
      <li>
        {builtIn.length
          ? t('admin.documentTemplates.word.builtIn', 'Built-in placeholders: {{list}}', {
              list: list(builtIn)
            })
          : t('admin.documentTemplates.word.noBuiltIn', 'No built-in placeholders.')}
      </li>
      <li>
        {fields.length
          ? t('admin.documentTemplates.word.fieldsFound', 'Fields: {{list}}', {
              list: list(fields)
            })
          : t('admin.documentTemplates.word.noFields', 'No fields of its own.')}
      </li>
      {info.page && (
        <li>
          {t('admin.documentTemplates.word.page', 'Page: {{width}} × {{height}} pt, {{layout}}.', {
            width: info.page.width,
            height: info.page.height,
            layout: info.page.landscape
              ? t('admin.documentTemplates.word.landscape', 'landscape')
              : t('admin.documentTemplates.word.portrait', 'portrait')
          })}
        </li>
      )}
      {!info.styles?.headings && (
        <li>
          {t(
            'admin.documentTemplates.word.noHeadings',
            'The template does not define Heading 1–3; headings use its theme fonts and colours.'
          )}
        </li>
      )}
    </ul>
  );
}

/** What was found in the PowerPoint template: slide size, the layout of each kind of slide, theme fonts. */
function PowerpointFindings({ info }) {
  const { t } = useTranslation();
  if (info.error) return <p className={`${CALLOUT_CLASS.warning} mt-2`}>{info.error}</p>;
  if (!info.layouts) return null;
  return (
    <div className="space-y-2">
      <p className={HELP_CLASS}>
        {t(
          'admin.documentTemplates.pptx.found',
          '{{count}} layouts, slide format {{size}}. iHub picks the layout of each kind of slide by itself:',
          { count: info.layouts.length, size: info.slideSize?.aspectRatio }
        )}
      </p>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        {SLIDE_KINDS.map(kind => (
          <div key={kind} className="contents">
            <dt className="text-gray-600 dark:text-gray-400">
              {t(`admin.documentTemplates.pptx.kinds.${kind}`, kind)}
            </dt>
            <dd className="text-gray-900 dark:text-gray-100">{info.mapping?.[kind] || '—'}</dd>
          </div>
        ))}
      </dl>
      {info.slots?.length > 0 && (
        <p className={HELP_CLASS}>
          {t(
            'admin.documentTemplates.pptx.slotsFound',
            'Text placeholders found by name, which a slide can fill besides its title and content: {{list}}.',
            { list: info.slots.map(slot => slot.id).join(', ') }
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Admin → Document templates → one template
 * (`/admin/document-templates/:templateId`, `new` for a new one).
 *
 * The design of a template lives in its Word and PowerPoint files. This page
 * holds what a file cannot: the name, the company name, the brand colours
 * (read from the files unless set here), the margins of PDFs and the fields.
 * Settings are edited as a draft and saved together; the Office files are
 * uploaded one by one and saved at once — with pending changes saved first,
 * so an upload never loses them. A new template is created with its name
 * first; files can be added after that.
 */
export default function AdminDocumentTemplateEditPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { templateId } = useParams();
  const isNew = templateId === 'new';
  const [draft, setDraft] = useState(() => (isNew ? emptyTemplate() : null));
  const [saved, setSaved] = useState(null);
  // A new template starts from the empty template; an existing one from what
  // the server returned (null until it loaded, so a failed load is never dirty).
  const [newTemplateBaseline] = useState(draft);
  const { blocker, markSaved, isDirty } = useUnsavedChanges(
    isNew ? newTemplateBaseline : saved,
    draft
  );
  const [files, setFiles] = useState({});
  const [resolved, setResolved] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busySlot, setBusySlot] = useState(null);
  const [preview, setPreview] = useState({ url: null, loading: false });
  const [errors, setErrors] = useState({});
  const previewUrlRef = useRef(null);

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    []
  );

  const apply = useCallback(response => {
    const template = normalizeTemplate(response.template);
    setDraft(template);
    setSaved(template);
    if (response.files) setFiles(response.files);
    if (response.resolved) setResolved(response.resolved);
  }, []);

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
        markSaved();
        navigate(`/admin/document-templates/${encodeURIComponent(response.id)}`, {
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

  /** Drops the unsaved settings: the draft goes back to what is saved (or to the empty template). */
  const discard = () => {
    setDraft(isNew ? newTemplateBaseline : saved);
    setErrors({});
    setMessage(null);
  };

  const upload = async (slot, file) => {
    if (dirty && !(await save())) return;
    setBusySlot(slot);
    setMessage(null);
    try {
      apply(await uploadDocumentTemplateFile(draft.id, slot, file));
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

  const remove = async slot => {
    if (dirty && !(await save())) return;
    setBusySlot(slot);
    setMessage(null);
    try {
      apply(await removeDocumentTemplateFile(draft.id, slot));
    } catch (error) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(error) });
    } finally {
      setBusySlot(null);
    }
  };

  /** Copy the colours of a file's theme into the colour fields (not saved until the admin saves). */
  const takeColours = async (slot, fileLabel) => {
    setBusySlot(`colours:${slot}`);
    setMessage(null);
    try {
      const brand = await readDocumentTemplateBrand(draft.id, slot);
      const taken = ['primaryColor', 'accentColor', 'textColor'].filter(key => brand[key]);
      if (!taken.length) {
        setMessage({
          type: 'error',
          text: t(
            'admin.documentTemplates.brand.noColours',
            'The {{file}} has no theme colours to take.',
            { file: fileLabel }
          )
        });
        return;
      }
      setDraft(current => ({
        ...current,
        brand: { ...current.brand, ...Object.fromEntries(taken.map(key => [key, brand[key]])) }
      }));
      setMessage({
        type: 'success',
        text: t(
          'admin.documentTemplates.brand.taken',
          'Colours taken from the {{file}}. Save to keep them.',
          { file: fileLabel }
        )
      });
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
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = URL.createObjectURL(blob);
        setPreview({ url: previewUrlRef.current, loading: false });
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
  const pptxInfo = files.powerpointTemplate;
  const wordInfo = files.wordTemplate;
  const brand = resolved?.brand;
  const wordLabel = t('admin.documentTemplates.files.wordTemplate', 'Word template');
  const pptxLabel = t('admin.documentTemplates.files.powerpointTemplate', 'PowerPoint template');

  return (
    <>
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
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={() => navigate('/admin/document-templates')}
          >
            <Icon name="arrow-left" className="h-4 w-4" />
            {t('common.back', 'Back')}
          </button>
        </div>

        {message && (
          <div
            role={message.type === 'error' ? 'alert' : 'status'}
            className={`${message.type === 'error' ? CALLOUT_CLASS.danger : CALLOUT_CLASS.success} mb-6`}
          >
            {message.text}
          </div>
        )}

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
              // No error summary here: the line announces itself.
              announceError
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
                'Create the template first; then you can upload your Word and PowerPoint templates, set the company name and declare fields.'
              )}
            </p>
          )}

          {!isNew && (
            <>
              <Section
                title={t('admin.documentTemplates.edit.word', 'Word template')}
                description={t(
                  'admin.documentTemplates.edit.wordHelp',
                  'Upload your Word template (.dotx or .docx). Its styles, headers, footers (logo, letterhead, page numbers), page setup and theme are used. Type {{placeholders}} in it where text is filled in.',
                  { placeholders: '{{title}}, {{author}}, {{date}}, {{content}}' }
                )}
              >
                <TemplateFileSlot
                  label={wordLabel}
                  accept=".docx,.dotx"
                  fileName={draft.docx.template}
                  busy={busySlot === 'wordTemplate'}
                  onUpload={file => upload('wordTemplate', file)}
                  onRemove={() => remove('wordTemplate')}
                >
                  {wordInfo && <WordFindings info={wordInfo} />}
                </TemplateFileSlot>
                <MarginFields
                  margins={draft.pdf.margins}
                  resolved={resolved?.pdf?.margins}
                  source={resolved?.pdf?.source}
                  hasWord={Boolean(draft.docx.template)}
                  error={errors.margins}
                  onChange={margins => update('pdf', 'margins', margins)}
                  onReset={() => {
                    const pdf = { ...draft.pdf };
                    delete pdf.margins;
                    setDraft(current => ({ ...current, pdf }));
                  }}
                />
              </Section>

              <Section
                title={t('admin.documentTemplates.edit.powerpoint', 'PowerPoint template')}
                description={t(
                  'admin.documentTemplates.edit.powerpointHelp',
                  'Upload your slide template (.potx or .pptx). Slides use its layouts, so titles, text, fonts, colours, logos, footers and slide numbers come from it; sample slides in the file are not copied. Without a template, slides are made in the brand colours.'
                )}
              >
                <TemplateFileSlot
                  label={pptxLabel}
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
                {pptxInfo && <PowerpointFindings info={pptxInfo} />}
              </Section>

              <Section
                title={t('admin.documentTemplates.edit.brand', 'Company and brand')}
                description={t(
                  'admin.documentTemplates.edit.brandHelp',
                  'Used in charts, spreadsheets, PDFs and web pages, and for the {{company}} placeholder. Colours and fonts are read from the themes of the Word and PowerPoint templates; set a colour here only to override it.',
                  { company: '{{company}}' }
                )}
              >
                <Field
                  label={t('admin.documentTemplates.edit.companyName', 'Company name')}
                  help={t(
                    'admin.documentTemplates.edit.companyHelp',
                    'The author of documents without one, the {{company}} placeholder and the footer of PDFs.',
                    { company: '{{company}}' }
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
                <div className="grid gap-4 sm:grid-cols-3">
                  <ColorField
                    label={t('admin.documentTemplates.edit.primaryColor', 'Primary colour')}
                    value={draft.brand.primaryColor}
                    resolved={brand?.primaryColor}
                    source={brand?.sources?.primaryColor}
                    onChange={value => update('brand', 'primaryColor', value)}
                    error={errors.primaryColor}
                  />
                  <ColorField
                    label={t('admin.documentTemplates.edit.accentColor', 'Accent colour')}
                    value={draft.brand.accentColor}
                    resolved={brand?.accentColor}
                    source={brand?.sources?.accentColor}
                    onChange={value => update('brand', 'accentColor', value)}
                    error={errors.accentColor}
                  />
                  <ColorField
                    label={t('admin.documentTemplates.edit.textColor', 'Text colour')}
                    value={draft.brand.textColor}
                    resolved={brand?.textColor}
                    source={brand?.sources?.textColor}
                    onChange={value => update('brand', 'textColor', value)}
                    error={errors.textColor}
                  />
                </div>
                {(draft.pptx.template || draft.docx.template) && (
                  <div className="flex flex-wrap gap-2">
                    {draft.pptx.template && (
                      <button
                        type="button"
                        className={SECONDARY_BUTTON_CLASS}
                        disabled={busySlot === 'colours:powerpointTemplate'}
                        onClick={() => takeColours('powerpointTemplate', pptxLabel)}
                      >
                        <Icon name="color-swatch" size="sm" />
                        {t(
                          'admin.documentTemplates.brand.takeFromPowerpoint',
                          'Take colours from the PowerPoint template'
                        )}
                      </button>
                    )}
                    {draft.docx.template && (
                      <button
                        type="button"
                        className={SECONDARY_BUTTON_CLASS}
                        disabled={busySlot === 'colours:wordTemplate'}
                        onClick={() => takeColours('wordTemplate', wordLabel)}
                      >
                        <Icon name="color-swatch" size="sm" />
                        {t(
                          'admin.documentTemplates.brand.takeFromWord',
                          'Take colours from the Word template'
                        )}
                      </button>
                    )}
                  </div>
                )}
                {brand && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {t('admin.documentTemplates.brand.palette', 'Palette and fonts')}
                    </h3>
                    <p className={HELP_CLASS}>
                      {t(
                        'admin.documentTemplates.brand.derivedHelp',
                        'Read from the templates and told to the model; they cannot be edited here. Charts use the palette. Saved template shown.'
                      )}
                    </p>
                    <Swatches colors={brand.palette || []} />
                    <p className="text-xs text-gray-600 dark:text-gray-400">
                      {sourceText(brand.sources?.palette, t)}
                    </p>
                    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
                      <dt className="text-gray-600 dark:text-gray-400">
                        {t('admin.documentTemplates.edit.headingFont', 'Heading font')}
                      </dt>
                      <dd className="text-gray-900 dark:text-gray-100">
                        {brand.headingFont || '—'}
                        {brand.headingFont && (
                          <span className="ml-2 text-xs text-gray-600 dark:text-gray-400">
                            {sourceText(brand.sources?.headingFont, t)}
                          </span>
                        )}
                      </dd>
                      <dt className="text-gray-600 dark:text-gray-400">
                        {t('admin.documentTemplates.edit.bodyFont', 'Body font')}
                      </dt>
                      <dd className="text-gray-900 dark:text-gray-100">
                        {brand.bodyFont || '—'}
                        {brand.bodyFont && (
                          <span className="ml-2 text-xs text-gray-600 dark:text-gray-400">
                            {sourceText(brand.sources?.bodyFont, t)}
                          </span>
                        )}
                      </dd>
                    </dl>
                  </div>
                )}
              </Section>

              <Section
                title={t('admin.documentTemplates.edit.fields', 'Fields')}
                description={t(
                  'admin.documentTemplates.edit.fieldsHelp',
                  'Placeholders of your own in the Word template, such as {{classification}} or {{department}}. The model is told which fields a template has and asks the user for a required one that has no value.',
                  { classification: '{{classification}}', department: '{{department}}' }
                )}
              >
                <TemplateFields
                  fields={draft.fields}
                  foundInWord={wordInfo && !wordInfo.error ? wordInfo.customFields : undefined}
                  errors={errors}
                  onChange={fields => update(null, 'fields', fields)}
                />
                {errors.fields && (
                  <p className="text-xs text-red-700 dark:text-red-300" role="alert">
                    {errors.fields}
                  </p>
                )}
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

      <AdminSaveBar
        dirty={isDirty}
        saving={saving}
        saveLabel={isNew ? t('admin.ui.saveBar.create', 'Create') : undefined}
        message={message?.type === 'error' ? message.text : undefined}
        onSave={() => void save()}
        onDiscard={discard}
      />
      <UnsavedChangesDialog blocker={blocker} />
    </>
  );
}
