import { useEffect, useRef, useState } from 'react';
import { makeAdminApiCall } from '../../../../api/adminApi';
import { AudioBufferRecorder } from '../../../../utils/audioRecorder';
import { audioBufferToWav } from '../../../../utils/wav';
import { getMicrophoneErrorMessage } from '../../../voice/utils/speechService';

/** Languages Voxtral TTS speaks (server/tts/language.js). */
export const TTS_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'hi', 'ar'];

/** A good voice sample: one speaker, clean audio, a few sentences. */
const MIN_SAMPLE_SECONDS = 5;
const MAX_SAMPLE_SECONDS = 30;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Language code → name in the admin's language ("de" → "German"). */
export function languageName(code, uiLanguage) {
  try {
    return new Intl.DisplayNames([uiLanguage || 'en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const errorText = (error, fallback) => error?.response?.data?.error || error?.message || fallback;

/**
 * Voices of a saved text-to-speech model (Admin → Models → a TTS model):
 *   - lists the provider's voices — the presets and the account's own — with
 *     buttons to use one as the model's voice or for a language;
 *   - creates a custom voice from a recording made here or an uploaded file,
 *     once the admin confirms the speaker agreed;
 *   - deletes custom voices.
 * Creating and deleting act on the provider account straight away; using a
 * voice only changes the form, which still has to be saved.
 *
 * @param {Object} props
 * @param {string} props.modelId - The saved model; its stored key is used.
 * @param {(voiceId: string, language: string|null) => void} props.onUseVoice
 * @param {Function} props.t
 * @param {string} props.uiLanguage
 */
function TtsVoicesPanel({ modelId, onUseVoice, t, uiLanguage }) {
  const [voices, setVoices] = useState(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');

  const [name, setName] = useState('');
  const [languages, setLanguages] = useState([]);
  const [gender, setGender] = useState('');
  const [consent, setConsent] = useState(false);
  const [sample, setSample] = useState(null); // { blob, filename, seconds, source }
  const [previewUrl, setPreviewUrl] = useState('');
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [created, setCreated] = useState(null);
  const recorderRef = useRef(null);

  // Leaving the page releases the microphone and the preview.
  useEffect(() => () => recorderRef.current?.cancel(), []);
  useEffect(() => () => previewUrl && URL.revokeObjectURL(previewUrl), [previewUrl]);

  const loadVoices = async () => {
    setLoading(true);
    setListError('');
    try {
      const response = await makeAdminApiCall(`/admin/models/${modelId}/tts/voices`);
      setVoices(Array.isArray(response.data?.voices) ? response.data.voices : []);
    } catch (error) {
      setListError(
        errorText(error, t('admin.models.ttsVoices.loadError', 'Could not load voices'))
      );
    } finally {
      setLoading(false);
    }
  };

  const deleteVoice = async voice => {
    if (
      !confirm(
        t(
          'admin.models.ttsVoices.deleteConfirm',
          'Delete the voice "{{name}}" from the provider account? Models that use it can no longer speak with it.',
          { name: voice.name }
        )
      )
    ) {
      return;
    }
    try {
      await makeAdminApiCall(`/admin/models/${modelId}/tts/voices/${voice.id}`, {
        method: 'DELETE'
      });
      setVoices(prev => (prev || []).filter(v => v.id !== voice.id));
    } catch (error) {
      setListError(
        errorText(error, t('admin.models.ttsVoices.deleteError', 'Could not delete the voice'))
      );
    }
  };

  // `preview` is an object URL for a recording made here, or '' for an
  // uploaded file, which is not played back on this page.
  const takeSample = (blob, filename, seconds, source, preview = '') => {
    setPreviewUrl(preview);
    setSample({ blob, filename, seconds, source });
    setCreated(null);
    setCreateError('');
  };

  const startRecording = async () => {
    setCreateError('');
    const recorder = new AudioBufferRecorder({
      maxDurationSeconds: MAX_SAMPLE_SECONDS,
      onTick: setElapsed,
      onMaxDuration: () => stopRecording()
    });
    recorderRef.current = recorder;
    setElapsed(0);
    try {
      await recorder.start();
      setRecording(true);
    } catch (error) {
      recorderRef.current = null;
      setCreateError(getMicrophoneErrorMessage(error, t));
    }
  };

  async function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setRecording(false);
    try {
      const { audioBuffer, durationSeconds } = await recorder.stop();
      if (!audioBuffer?.length) {
        setCreateError(t('admin.models.ttsVoices.emptyRecording', 'Nothing was recorded.'));
        return;
      }
      // Only a recording is previewed: its bytes come from our own encoder,
      // not from a file the browser was handed.
      const wav = audioBufferToWav(audioBuffer);
      takeSample(wav, 'recording.wav', durationSeconds, 'recording', URL.createObjectURL(wav));
    } catch (error) {
      setCreateError(getMicrophoneErrorMessage(error, t));
    }
  }

  const pickFile = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setCreateError(t('admin.models.ttsVoices.fileTooLarge', 'The file is larger than 10 MB.'));
      return;
    }
    let seconds = null;
    try {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await context.decodeAudioData(await file.arrayBuffer());
      seconds = decoded.duration;
      context.close?.();
    } catch {
      setCreateError(
        t('admin.models.ttsVoices.fileUnreadable', 'This file could not be read as audio.')
      );
      return;
    }
    takeSample(file, file.name, seconds, 'file');
  };

  const toggleLanguage = code =>
    setLanguages(prev => (prev.includes(code) ? prev.filter(l => l !== code) : [...prev, code]));

  const createVoice = async () => {
    setCreating(true);
    setCreateError('');
    try {
      const response = await makeAdminApiCall(`/admin/models/${modelId}/tts/voices`, {
        method: 'POST',
        body: {
          name: name.trim(),
          audio: await blobToBase64(sample.blob),
          filename: sample.filename,
          languages,
          ...(gender ? { gender } : {})
        }
      });
      const voice = response.data?.voice;
      setCreated(voice || null);
      if (voice && voices) setVoices(prev => [voice, ...(prev || [])]);
      setName('');
      setConsent(false);
    } catch (error) {
      setCreateError(
        errorText(error, t('admin.models.ttsVoices.createError', 'Could not create the voice'))
      );
    } finally {
      setCreating(false);
    }
  };

  const tooShort = sample?.seconds != null && sample.seconds < MIN_SAMPLE_SECONDS;
  const canCreate = Boolean(name.trim() && sample && consent && !tooShort && !creating);

  const renderUseButtons = voice => (
    <span className="flex flex-wrap gap-1">
      <button
        type="button"
        onClick={() => onUseVoice(voice.id, null)}
        className="px-2 py-0.5 text-xs rounded border border-indigo-300 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20"
      >
        {t('admin.models.ttsVoices.useDefault', 'Use as voice')}
      </button>
      {voice.languages
        .map(code => String(code).slice(0, 2).toLowerCase())
        .filter(code => TTS_LANGUAGES.includes(code))
        .filter((code, i, all) => all.indexOf(code) === i)
        .map(code => (
          <button
            key={code}
            type="button"
            onClick={() => onUseVoice(voice.id, code)}
            className="px-2 py-0.5 text-xs rounded border border-gray-300 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            {t('admin.models.ttsVoices.useFor', 'Use for {{language}}', {
              language: languageName(code, uiLanguage)
            })}
          </button>
        ))}
    </span>
  );

  const custom = (voices || []).filter(v => v.type === 'custom');
  const presets = (voices || []).filter(v => v.type !== 'custom');
  const sectionClass =
    'rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-3 bg-gray-50 dark:bg-gray-900/30';
  const inputClass =
    'block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm';

  return (
    <div className="space-y-4">
      <div className={sectionClass}>
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('admin.models.ttsVoices.title', 'Available voices')}
          </h4>
          <button
            type="button"
            onClick={loadVoices}
            disabled={loading}
            className="px-3 py-1.5 text-sm rounded-md border border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 disabled:opacity-50"
          >
            {loading
              ? t('common.loading', 'Loading...')
              : voices
                ? t('admin.models.ttsVoices.reload', 'Reload')
                : t('admin.models.ttsVoices.load', 'Show voices')}
          </button>
        </div>
        {listError && <p className="text-sm text-red-600 dark:text-red-400">{listError}</p>}
        {voices && (
          <div className="space-y-3">
            <div>
              <p className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                {t('admin.models.ttsVoices.custom', 'Your voices')}
              </p>
              {custom.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('admin.models.ttsVoices.noCustom', 'No custom voices yet. Create one below.')}
                </p>
              ) : (
                <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                  {custom.map(voice => (
                    <li key={voice.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {voice.name}
                      </span>
                      <code className="text-xs text-gray-500">{voice.id}</code>
                      <span className="text-xs text-gray-500">
                        {voice.languages.map(code => languageName(code, uiLanguage)).join(', ')}
                      </span>
                      <span className="grow" />
                      {renderUseButtons(voice)}
                      <button
                        type="button"
                        onClick={() => deleteVoice(voice)}
                        className="px-2 py-0.5 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                      >
                        {t('common.delete', 'Delete')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                {t('admin.models.ttsVoices.presets', 'Preset voices ({{count}})', {
                  count: presets.length
                })}
              </summary>
              <ul className="mt-2 divide-y divide-gray-200 dark:divide-gray-700">
                {presets.map(voice => (
                  <li key={voice.id} className="py-1.5 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-gray-900 dark:text-gray-100">{voice.name}</span>
                    <code className="text-xs text-gray-500">{voice.slug || voice.id}</code>
                    <span className="grow" />
                    {renderUseButtons({ ...voice, id: voice.slug || voice.id })}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </div>

      <div className={sectionClass}>
        <div>
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('admin.models.ttsVoices.createTitle', 'Create a custom voice')}
          </h4>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.models.ttsVoices.createHint',
              'Record or upload 10–30 seconds of one person speaking naturally, without music or background noise. The voice is created in the provider account straight away; it reads every language, with the accent of the recording.'
            )}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-sm text-gray-700 dark:text-gray-300">
            {t('admin.models.ttsVoices.name', 'Name')}
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={100}
              placeholder={t('admin.models.ttsVoices.namePlaceholder', 'e.g. Anna (German)')}
              className={`mt-1 ${inputClass}`}
            />
          </label>
          <label className="text-sm text-gray-700 dark:text-gray-300">
            {t('admin.models.ttsVoices.gender', 'Gender (optional)')}
            <select
              value={gender}
              onChange={e => setGender(e.target.value)}
              className={`mt-1 ${inputClass}`}
            >
              <option value="">—</option>
              <option value="female">{t('admin.models.ttsVoices.female', 'Female')}</option>
              <option value="male">{t('admin.models.ttsVoices.male', 'Male')}</option>
            </select>
          </label>
        </div>

        <fieldset>
          <legend className="text-sm text-gray-700 dark:text-gray-300">
            {t('admin.models.ttsVoices.languages', 'Language of the recording')}
          </legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {TTS_LANGUAGES.map(code => (
              <label
                key={code}
                className="flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300"
              >
                <input
                  type="checkbox"
                  checked={languages.includes(code)}
                  onChange={() => toggleLanguage(code)}
                  className="rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                {languageName(code, uiLanguage)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          {recording ? (
            <button
              type="button"
              onClick={() => stopRecording()}
              className="px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700"
            >
              {t('admin.models.ttsVoices.stopRecording', 'Stop recording ({{seconds}} s)', {
                seconds: Math.floor(elapsed)
              })}
            </button>
          ) : (
            <button
              type="button"
              onClick={startRecording}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {t('admin.models.ttsVoices.record', 'Record with microphone')}
            </button>
          )}
          <label className="px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">
            {t('admin.models.ttsVoices.upload', 'Upload audio file')}
            <input type="file" accept="audio/*" onChange={pickFile} className="sr-only" />
          </label>
          {sample && (
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {sample.source === 'recording'
                ? t('admin.models.ttsVoices.recorded', 'Recording')
                : sample.filename}
              {sample.seconds != null && ` · ${sample.seconds.toFixed(1)} s`}
            </span>
          )}
        </div>
        {previewUrl && (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- a voice sample has no captions
          <audio controls src={previewUrl} className="w-full" />
        )}
        {tooShort && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {t(
              'admin.models.ttsVoices.tooShort',
              'The sample is shorter than {{seconds}} seconds; record a little more.',
              { seconds: MIN_SAMPLE_SECONDS }
            )}
          </p>
        )}

        <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={consent}
            onChange={e => setConsent(e.target.checked)}
            className="mt-0.5 rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          {t(
            'admin.models.ttsVoices.consent',
            'The person speaking in this sample agreed that their voice is cloned and used to read answers aloud.'
          )}
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={createVoice}
            disabled={!canCreate}
            className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {creating
              ? t('admin.models.ttsVoices.creating', 'Creating…')
              : t('admin.models.ttsVoices.create', 'Create voice')}
          </button>
          {createError && (
            <span className="text-sm text-red-600 dark:text-red-400">{createError}</span>
          )}
        </div>

        {created && (
          <div className="rounded-md bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-800 dark:text-green-300 space-y-2">
            <p>
              {t(
                'admin.models.ttsVoices.created',
                'Voice "{{name}}" created ({{id}}). Use it below, then save the model.',
                { name: created.name, id: created.id }
              )}
            </p>
            {renderUseButtons(created)}
          </div>
        )}
      </div>
    </div>
  );
}

export default TtsVoicesPanel;
