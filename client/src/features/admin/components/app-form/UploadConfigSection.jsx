import MimeTypeSelector from '../MimeTypeSelector';
import { updateIn } from '../../utils/nestedUpdate';

// The file-based upload types (image/file/audio/video) only differ in the
// MimeTypeSelector category, translation keys, size defaults/bounds, and an
// optional extra "on by default unless explicitly false" toggle (resize for
// images, audio extraction for video) — everything else is identical.
const UPLOAD_TYPE_CONFIGS = {
  imageUpload: {
    categoryType: 'images',
    enableLabel: ['admin.apps.edit.enableImageUpload', 'Enable Image Upload'],
    maxSizeLabel: ['admin.apps.edit.maxImageSize', 'Max Image Size (MB)'],
    formatsLabel: ['admin.apps.edit.supportedImageFormats', 'Supported Image Formats'],
    defaultMaxFileSizeMB: 10,
    maxFileSizeUpperBound: 50,
    defaultFormats: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
    extraToggle: {
      field: 'resizeImages',
      label: ['admin.apps.edit.resizeImages', 'Resize Images'],
      checkboxClassName:
        'h-3 w-3 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded',
      labelClassName: 'ml-2 block text-xs text-gray-700'
    }
  },
  fileUpload: {
    categoryType: 'documents',
    enableLabel: ['admin.apps.edit.enableFileUpload', 'Enable File Upload'],
    maxSizeLabel: ['admin.apps.edit.maxFileSize', 'Max File Size (MB)'],
    formatsLabel: ['admin.apps.edit.supportedFormats', 'Supported File Formats'],
    defaultMaxFileSizeMB: 5,
    maxFileSizeUpperBound: 100,
    defaultFormats: [
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/json',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
  },
  audioUpload: {
    categoryType: 'audio',
    enableLabel: ['admin.apps.edit.enableAudioUpload', 'Enable Audio Upload'],
    maxSizeLabel: ['admin.apps.edit.maxAudioSize', 'Max Audio File Size (MB)'],
    formatsLabel: ['admin.apps.edit.supportedAudioFormats', 'Supported Audio Formats'],
    defaultMaxFileSizeMB: 20,
    maxFileSizeUpperBound: 2000,
    defaultFormats: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/ogg']
  },
  videoUpload: {
    categoryType: 'video',
    enableLabel: ['admin.apps.edit.enableVideoUpload', 'Enable Video Upload'],
    maxSizeLabel: ['admin.apps.edit.maxVideoSize', 'Max Video File Size (MB)'],
    formatsLabel: ['admin.apps.edit.supportedVideoFormats', 'Supported Video Formats'],
    defaultMaxFileSizeMB: 50,
    maxFileSizeUpperBound: 2000,
    defaultFormats: ['video/mp4', 'video/webm', 'video/quicktime'],
    extraToggle: {
      field: 'extractAudio',
      label: [
        'admin.apps.edit.extractAudioFromVideo',
        'Extract audio track (for transcription / audio models)'
      ],
      checkboxClassName:
        'h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded',
      labelClassName: 'ml-2 block text-xs font-medium text-gray-700'
    }
  }
};

function UploadTypeCard({ app, onChange, uploadKey, t, parseNumberOrUndefined }) {
  const config = UPLOAD_TYPE_CONFIGS[uploadKey];
  const typeConfig = app.upload?.[uploadKey] || {};

  const updateTypeConfig = patch =>
    onChange('upload', updateIn(app.upload || {}, [uploadKey], { ...typeConfig, ...patch }));

  return (
    <div>
      <div className="flex items-center mb-2">
        <input
          type="checkbox"
          checked={typeConfig.enabled || false}
          onChange={e => updateTypeConfig({ enabled: e.target.checked })}
          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
        />
        <label className="ml-2 block text-sm font-medium text-gray-900">
          {t(...config.enableLabel)}
        </label>
      </div>
      {typeConfig.enabled && (
        <div className="ml-6 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700">
              {t(...config.maxSizeLabel)}
            </label>
            <input
              type="number"
              min="1"
              max={config.maxFileSizeUpperBound}
              value={typeConfig.maxFileSizeMB || config.defaultMaxFileSizeMB}
              onChange={e =>
                updateTypeConfig({
                  maxFileSizeMB: parseNumberOrUndefined(e.target.value, parseInt)
                })
              }
              className="mt-1 block w-20 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-xs"
            />
          </div>
          {config.extraToggle && (
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={typeConfig[config.extraToggle.field] !== false}
                onChange={e => updateTypeConfig({ [config.extraToggle.field]: e.target.checked })}
                className={config.extraToggle.checkboxClassName}
              />
              <label className={config.extraToggle.labelClassName}>
                {t(...config.extraToggle.label)}
              </label>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">
              {t(...config.formatsLabel)}
            </label>
            <MimeTypeSelector
              categoryType={config.categoryType}
              selectedFormats={typeConfig.supportedFormats || config.defaultFormats}
              onChange={newFormats => updateTypeConfig({ supportedFormats: newFormats })}
              defaultFormats={config.defaultFormats}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Upload Configuration card of the app form editor: whether uploads are
 * enabled at all, plus per-type (image/file/audio/cloud-storage) settings.
 *
 * @param {Object} app - the app configuration object
 * @param {Function} onChange - `(field, value) => void`, same handler AppFormEditor
 *   passes to every other top-level field (`handleInputChange`)
 * @param {Function} t - translation function
 * @param {Function} parseNumberOrUndefined - shared numeric-input parser (NaN → undefined)
 */
export default function UploadConfigSection({ app, onChange, t, parseNumberOrUndefined }) {
  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.upload', 'Upload Configuration')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.uploadDesc', 'Configure file and image upload capabilities')}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-6">
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.upload?.enabled || false}
                onChange={e => onChange('upload', { ...app.upload, enabled: e.target.checked })}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.enableUpload', 'Enable Upload')}
              </label>
            </div>

            {app.upload?.enabled && (
              <div className="space-y-4 pl-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={app.upload?.allowMultiple || false}
                    onChange={e =>
                      onChange('upload', { ...app.upload, allowMultiple: e.target.checked })
                    }
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                    {t('admin.apps.edit.allowMultiple', 'Allow Multiple Files')}
                  </label>
                </div>

                <UploadTypeCard
                  app={app}
                  onChange={onChange}
                  uploadKey="imageUpload"
                  t={t}
                  parseNumberOrUndefined={parseNumberOrUndefined}
                />
                <UploadTypeCard
                  app={app}
                  onChange={onChange}
                  uploadKey="fileUpload"
                  t={t}
                  parseNumberOrUndefined={parseNumberOrUndefined}
                />
                <UploadTypeCard
                  app={app}
                  onChange={onChange}
                  uploadKey="audioUpload"
                  t={t}
                  parseNumberOrUndefined={parseNumberOrUndefined}
                />
                <UploadTypeCard
                  app={app}
                  onChange={onChange}
                  uploadKey="videoUpload"
                  t={t}
                  parseNumberOrUndefined={parseNumberOrUndefined}
                />

                <div>
                  <div className="flex items-center mb-2">
                    <input
                      type="checkbox"
                      checked={app.upload?.cloudStorageUpload?.enabled || false}
                      onChange={e =>
                        onChange(
                          'upload',
                          updateIn(
                            app.upload || {},
                            ['cloudStorageUpload', 'enabled'],
                            e.target.checked
                          )
                        )
                      }
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                    />
                    <label className="ml-2 block text-sm font-medium text-gray-900">
                      {t('admin.apps.edit.enableCloudStorageUpload', 'Enable Cloud Storage Upload')}
                    </label>
                  </div>
                  {app.upload?.cloudStorageUpload?.enabled && (
                    <div className="ml-6">
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t(
                          'admin.apps.edit.cloudStorageUploadDesc',
                          'Allow users to select files from configured cloud storage providers (Office 365, Google Drive). Global cloud storage must be enabled in Providers settings.'
                        )}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
