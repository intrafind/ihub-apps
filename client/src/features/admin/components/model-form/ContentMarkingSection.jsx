import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../../api/adminApi';
import { usePlatformConfig } from '../../../../shared/contexts/PlatformConfigContext';
import {
  DEFAULT_WATERMARK_MIN_TOKENS,
  isImageModel,
  isTextMarked
} from '../../../../../../shared/aiTransparency.js';
import {
  MARKING_ID_PATTERN,
  buildImageWatermark,
  buildTextWatermark,
  parseImageWatermark,
  parseTextWatermark,
  updateContentMarking
} from '../../utils/aiTransparencyAdmin';

const inputClass =
  'mt-1 block w-full rounded-md border-gray-300 bg-white text-gray-900 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100';
const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

/**
 * Format a record timestamp for the admin's language.
 * @param {string} value - ISO timestamp
 * @param {string} language - i18n language code
 * @returns {string}
 */
function formatDate(value, language) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return date.toLocaleString(language || undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toISOString();
  }
}

/**
 * "Content marking (EU AI Act)" section of the model editor (issue #2565,
 * concept §8.2): declares how this model's output is machine-readably marked,
 * which drives both the marking itself and the compliance report.
 *
 * Edits `model.contentMarking`:
 * - `textWatermark`: `'none'` | `'upstream:<vendor>'` (the vendor marks the
 *   text, documented in writing) | `{ scheme: 'vllm-gumbel', keyGroup, perRequest }`
 *   (self-hosted vLLM with iHub's watermark key group)
 * - `imageWatermark`: `'none'` | `'upstream:<technique>'` (e.g. `upstream:synthid`)
 * - `notes`: free text for the compliance report
 *
 * The acknowledgement of an unmarked model is a server-managed record and is
 * shown read-only; it is created by enabling the model with a justification.
 * Transcription models are out of scope (standard editing) and only get a note.
 *
 * @param {Object} props
 * @param {Object} props.model - Model config being edited
 * @param {(model: Object) => void} props.onChange - Updates the model in the editor
 * @returns {JSX.Element}
 */
function ContentMarkingSection({ model, onChange }) {
  const { t, i18n } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const [keyGroups, setKeyGroups] = useState([]);
  const marking = model.contentMarking || {};
  const text = parseTextWatermark(marking.textWatermark);
  const image = parseImageWatermark(marking.imageWatermark);
  const acknowledgement = marking.acknowledgement || null;
  const isTranscription = model.modelType === 'transcription';
  const showImage = isImageModel(model) || image.mode !== 'none';
  const minTokens =
    Number(platformConfig?.aiTransparency?.text?.watermarkMinTokens) ||
    DEFAULT_WATERMARK_MIN_TOKENS;
  const notMarked = !isTranscription && !isTextMarked(model);

  // Key groups offered as suggestions for the vLLM watermark. Best effort:
  // the id can always be typed.
  useEffect(() => {
    if (text.mode !== 'vllm') return undefined;
    let active = true;
    makeAdminApiCall('/admin/ai-transparency/key-groups')
      .then(response => {
        if (!active) return;
        const list = Array.isArray(response?.data?.keyGroups) ? response.data.keyGroups : [];
        setKeyGroups(list.map(group => group?.id).filter(Boolean));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [text.mode]);

  const setMarking = (field, value) => {
    onChange({
      ...model,
      contentMarking: updateContentMarking(model.contentMarking, field, value)
    });
  };
  const setText = patch => setMarking('textWatermark', buildTextWatermark({ ...text, ...patch }));
  const setImage = patch =>
    setMarking('imageWatermark', buildImageWatermark({ ...image, ...patch }));

  const vendorInvalid = text.mode === 'upstream' && !MARKING_ID_PATTERN.test(text.vendor);
  const keyGroupInvalid =
    text.mode === 'vllm' && text.keyGroup !== '' && !MARKING_ID_PATTERN.test(text.keyGroup);
  const techniqueInvalid = image.mode === 'upstream' && !MARKING_ID_PATTERN.test(image.technique);
  const idFormatHint = t(
    'admin.models.marking.idFormat',
    'Lowercase letters, digits, dot, underscore and hyphen only.'
  );

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.models.marking.title', 'Content marking (EU AI Act)')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.models.marking.description',
              'How the output of this model is marked machine-readably (Art. 50(2)). Drives the marking and the compliance report.'
            )}
          </p>
        </div>
        <div className="mt-5 space-y-6 md:col-span-2 md:mt-0">
          {isTranscription ? (
            <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
              <Icon
                name="information-circle"
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              {t(
                'admin.models.marking.transcription',
                'Transcription counts as standard editing and is out of scope of the marking duty.'
              )}
            </p>
          ) : (
            <>
              {notMarked && (
                <div
                  role="note"
                  className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100"
                >
                  <Icon
                    name="exclamation-triangle"
                    className="mt-0.5 h-5 w-5 shrink-0"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="font-medium">
                      {t('admin.models.marking.warningTitle', 'This model does not mark its text')}
                    </p>
                    <p className="mt-1">
                      {t(
                        'admin.models.marking.warningBody',
                        'Free-form answers over {{count}} tokens are not watermarked — non-conforming under the EU AI Act Code of Practice (Measure 1.1.2). Enabling it requires a justification, and it stays listed as non-conforming until it is marked.',
                        { count: minTokens }
                      )}
                    </p>
                  </div>
                </div>
              )}

              <fieldset>
                <legend className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('admin.models.marking.text.legend', 'Text watermark')}
                </legend>
                <div className="mt-2 grid grid-cols-6 gap-4">
                  <div className="col-span-6 sm:col-span-3">
                    <label htmlFor="contentMarking.textWatermark" className={labelClass}>
                      {t('admin.models.marking.text.label', 'Marking')}
                    </label>
                    <select
                      id="contentMarking.textWatermark"
                      value={text.mode}
                      onChange={e => setText({ mode: e.target.value })}
                      className={inputClass}
                    >
                      <option value="none">
                        {t('admin.models.marking.text.none', 'Not marked')}
                      </option>
                      <option value="upstream">
                        {t('admin.models.marking.text.upstream', 'Marked by the vendor')}
                      </option>
                      <option value="vllm">
                        {t('admin.models.marking.text.vllm', 'Self-hosted vLLM watermark')}
                      </option>
                    </select>
                  </div>

                  {text.mode === 'upstream' && (
                    <div className="col-span-6 sm:col-span-3">
                      <label htmlFor="contentMarking.vendor" className={labelClass}>
                        {t('admin.models.marking.text.vendor', 'Vendor')}
                      </label>
                      <input
                        id="contentMarking.vendor"
                        type="text"
                        value={text.vendor}
                        onChange={e => setText({ vendor: e.target.value })}
                        placeholder="google"
                        aria-invalid={vendorInvalid || undefined}
                        aria-describedby="contentMarking.vendor-hint"
                        className={inputClass}
                      />
                      <p
                        id="contentMarking.vendor-hint"
                        className={
                          vendorInvalid ? 'mt-1 text-xs text-red-700 dark:text-red-400' : hintClass
                        }
                      >
                        {vendorInvalid
                          ? idFormatHint
                          : t(
                              'admin.models.marking.text.vendorHint',
                              'Only when the vendor documents in writing that it watermarks this model’s text. Saved as upstream:<vendor>.'
                            )}
                      </p>
                    </div>
                  )}

                  {text.mode === 'vllm' && (
                    <>
                      <div className="col-span-6 sm:col-span-3">
                        <label htmlFor="contentMarking.keyGroup" className={labelClass}>
                          {t('admin.models.marking.text.keyGroup', 'Key group')}
                        </label>
                        <input
                          id="contentMarking.keyGroup"
                          type="text"
                          list="contentMarking.keyGroup-options"
                          value={text.keyGroup}
                          onChange={e => setText({ keyGroup: e.target.value })}
                          placeholder="default"
                          aria-invalid={keyGroupInvalid || undefined}
                          aria-describedby="contentMarking.keyGroup-hint"
                          className={inputClass}
                        />
                        <datalist id="contentMarking.keyGroup-options">
                          {keyGroups.map(id => (
                            <option key={id} value={id} />
                          ))}
                        </datalist>
                        <p
                          id="contentMarking.keyGroup-hint"
                          className={
                            keyGroupInvalid
                              ? 'mt-1 text-xs text-red-700 dark:text-red-400'
                              : hintClass
                          }
                        >
                          {keyGroupInvalid
                            ? idFormatHint
                            : t(
                                'admin.models.marking.text.keyGroupHint',
                                'The watermark key group configured in vLLM (--watermark-config). Empty uses "default".'
                              )}
                        </p>
                      </div>
                      <div className="col-span-6">
                        <div className="flex items-start gap-2">
                          <input
                            id="contentMarking.perRequest"
                            type="checkbox"
                            checked={text.perRequest}
                            onChange={e => setText({ perRequest: e.target.checked })}
                            aria-describedby="contentMarking.perRequest-hint"
                            className="mt-0.5 h-4 w-4 rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500 dark:border-gray-600"
                          />
                          <div>
                            <label
                              htmlFor="contentMarking.perRequest"
                              className="text-sm text-gray-900 dark:text-gray-100"
                            >
                              {t(
                                'admin.models.marking.text.perRequest',
                                'Send the per-request watermark flag'
                              )}
                            </label>
                            <p id="contentMarking.perRequest-hint" className={hintClass}>
                              {t(
                                'admin.models.marking.text.perRequestHint',
                                'For vLLM servers that switch the watermark on per request. Leave off when the server watermarks every response.'
                              )}
                            </p>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </fieldset>

              {showImage && (
                <fieldset>
                  <legend className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t('admin.models.marking.image.legend', 'Image watermark of the vendor')}
                  </legend>
                  <div className="mt-2 grid grid-cols-6 gap-4">
                    <div className="col-span-6 sm:col-span-3">
                      <label htmlFor="contentMarking.imageWatermark" className={labelClass}>
                        {t('admin.models.marking.image.label', 'Vendor watermark')}
                      </label>
                      <select
                        id="contentMarking.imageWatermark"
                        value={image.mode}
                        onChange={e => setImage({ mode: e.target.value })}
                        className={inputClass}
                      >
                        <option value="none">{t('admin.models.marking.image.none', 'None')}</option>
                        <option value="upstream">
                          {t('admin.models.marking.image.upstream', 'Marked by the vendor')}
                        </option>
                      </select>
                    </div>
                    {image.mode === 'upstream' && (
                      <div className="col-span-6 sm:col-span-3">
                        <label htmlFor="contentMarking.imageTechnique" className={labelClass}>
                          {t('admin.models.marking.image.technique', 'Technique')}
                        </label>
                        <input
                          id="contentMarking.imageTechnique"
                          type="text"
                          value={image.technique}
                          onChange={e => setImage({ technique: e.target.value })}
                          placeholder="synthid"
                          aria-invalid={techniqueInvalid || undefined}
                          aria-describedby="contentMarking.imageTechnique-hint"
                          className={inputClass}
                        />
                        <p
                          id="contentMarking.imageTechnique-hint"
                          className={
                            techniqueInvalid
                              ? 'mt-1 text-xs text-red-700 dark:text-red-400'
                              : hintClass
                          }
                        >
                          {techniqueInvalid
                            ? idFormatHint
                            : t(
                                'admin.models.marking.image.techniqueHint',
                                'E.g. synthid for Google images. Saved as upstream:<technique>.'
                              )}
                        </p>
                      </div>
                    )}
                    <p className="col-span-6 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.models.marking.image.hint',
                        'iHub adds its own Content Credentials (C2PA) and invisible watermark to every generated image, whatever the vendor does.'
                      )}
                    </p>
                  </div>
                </fieldset>
              )}
            </>
          )}

          <div>
            <label htmlFor="contentMarking.notes" className={labelClass}>
              {t('admin.models.marking.notes', 'Notes')}
            </label>
            <textarea
              id="contentMarking.notes"
              rows={2}
              value={marking.notes || ''}
              onChange={e => setMarking('notes', e.target.value)}
              aria-describedby="contentMarking.notes-hint"
              className={inputClass}
            />
            <p id="contentMarking.notes-hint" className={hintClass}>
              {t(
                'admin.models.marking.notesHint',
                'E.g. where the vendor documents its marking. Shown in the compliance report.'
              )}
            </p>
          </div>

          {acknowledgement && (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/40">
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {t('admin.models.marking.acknowledgement.title', 'Enabled although not marked')}
              </p>
              <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                <dt className="font-medium text-gray-500 dark:text-gray-400">
                  {t('admin.models.marking.acknowledgement.by', 'Acknowledged by')}
                </dt>
                <dd className="text-gray-900 dark:text-gray-100">
                  {acknowledgement.acknowledgedByName || acknowledgement.acknowledgedBy || '—'}
                  {acknowledgement.acknowledgedAt
                    ? ` · ${formatDate(acknowledgement.acknowledgedAt, i18n.language)}`
                    : ''}
                </dd>
                <dt className="font-medium text-gray-500 dark:text-gray-400">
                  {t('admin.models.marking.acknowledgement.justification', 'Justification')}
                </dt>
                <dd className="whitespace-pre-line break-words text-gray-900 dark:text-gray-100">
                  {acknowledgement.justification || '—'}
                </dd>
                <dt className="font-medium text-gray-500 dark:text-gray-400">
                  {t('admin.models.marking.acknowledgement.installation', 'Installation')}
                </dt>
                <dd className="break-all text-gray-900 dark:text-gray-100">
                  {[acknowledgement.installationUrl, acknowledgement.installationId]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </dd>
              </dl>
              <p className={hintClass}>
                {t(
                  'admin.models.marking.acknowledgement.hint',
                  'Recorded by the server when the model was enabled with a justification. It documents the gap; the model stays non-conforming.'
                )}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ContentMarkingSection;
