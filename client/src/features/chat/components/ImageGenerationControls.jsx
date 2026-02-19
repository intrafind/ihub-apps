import { useTranslation } from 'react-i18next';

/**
 * Image generation controls component
 * Displays aspect ratio and quality dropdowns for image generation models
 */
const ImageGenerationControls = ({
  app,
  model: _model,
  imageAspectRatio,
  imageQuality,
  onImageAspectRatioChange,
  onImageQualityChange,
  className = '',
  inline = false // New prop for inline display without labels
}) => {
  const { t } = useTranslation();

  // Check if image generation settings are disabled
  const imageGenDisabled = app?.settings?.imageGeneration?.enabled === false;

  // Available aspect ratios for image generation
  const aspectRatios = [
    { id: '1:1', name: '1:1 (Square)' },
    { id: '2:3', name: '2:3 (Portrait)' },
    { id: '3:2', name: '3:2 (Landscape)' },
    { id: '3:4', name: '3:4 (Portrait)' },
    { id: '4:3', name: '4:3 (Landscape)' },
    { id: '4:5', name: '4:5 (Portrait)' },
    { id: '5:4', name: '5:4 (Landscape)' },
    { id: '9:16', name: '9:16 (Phone Portrait)' },
    { id: '16:9', name: '16:9 (Widescreen)' },
    { id: '21:9', name: '21:9 (Ultrawide)' }
  ];

  // Available quality levels for image generation
  const qualityLevels = [
    { id: 'Low', name: t('appConfig.qualityLow', 'Low (1K)') },
    { id: 'Medium', name: t('appConfig.qualityMedium', 'Medium (2K)') },
    { id: 'High', name: t('appConfig.qualityHigh', 'High (4K)') }
  ];

  if (inline) {
    // Inline compact version without labels
    return (
      <div className={`flex gap-2 ${className}`}>
        {/* Aspect Ratio */}
        <select
          value={imageAspectRatio || '1:1'}
          onChange={e => onImageAspectRatioChange?.(e.target.value)}
          disabled={imageGenDisabled}
          title={t('appConfig.imageAspectRatio', 'Aspect Ratio')}
          className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-700 dark:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {aspectRatios.map(ratio => (
            <option key={ratio.id} value={ratio.id}>
              {ratio.name}
            </option>
          ))}
        </select>

        {/* Quality */}
        <select
          value={imageQuality || 'Medium'}
          onChange={e => onImageQualityChange?.(e.target.value)}
          disabled={imageGenDisabled}
          title={t('appConfig.imageQuality', 'Quality')}
          className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-700 dark:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {qualityLevels.map(level => (
            <option key={level.id} value={level.id}>
              {level.name}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className={`flex flex-col sm:flex-row gap-2 ${className}`}>
      {/* Aspect Ratio */}
      <div className="flex-1">
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('appConfig.imageAspectRatio', 'Aspect Ratio')}
        </label>
        <select
          value={imageAspectRatio || '1:1'}
          onChange={e => onImageAspectRatioChange?.(e.target.value)}
          disabled={imageGenDisabled}
          className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-700 dark:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {aspectRatios.map(ratio => (
            <option key={ratio.id} value={ratio.id}>
              {ratio.name}
            </option>
          ))}
        </select>
      </div>

      {/* Quality */}
      <div className="flex-1">
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('appConfig.imageQuality', 'Quality')}
        </label>
        <select
          value={imageQuality || 'Medium'}
          onChange={e => onImageQualityChange?.(e.target.value)}
          disabled={imageGenDisabled}
          className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-gray-700 dark:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {qualityLevels.map(level => (
            <option key={level.id} value={level.id}>
              {level.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};

export default ImageGenerationControls;
