import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

const WatermarkConfig = ({ config, onChange, showPreview = true, level = 'platform' }) => {
  const { t } = useTranslation();
  const fileInputRef = useRef(null);
  const canvasRef = useRef(null);

  const [watermarkConfig, setWatermarkConfig] = useState({
    enabled: false,
    text: '',
    logo: '',
    position: 'bottom-right',
    opacity: 0.5,
    textColor: '#ffffff',
    includeUser: false,
    includeTimestamp: false,
    installationId: '',
    enableC2PA: false,
    ...config
  });

  useEffect(() => {
    if (config) {
      setWatermarkConfig(prev => ({
        ...prev,
        ...config
      }));
    }
  }, [config]);

  useEffect(() => {
    if (showPreview && canvasRef.current) {
      renderPreview();
    }
  }, [watermarkConfig, showPreview]);

  const handleChange = (field, value) => {
    const newConfig = {
      ...watermarkConfig,
      [field]: value
    };
    setWatermarkConfig(newConfig);
    if (onChange) {
      onChange(newConfig);
    }
  };

  const handleLogoUpload = e => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = event => {
      const base64String = event.target.result;
      handleChange('logo', base64String);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => {
    handleChange('logo', '');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const renderPreview = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = 400;
    const height = 300;
    canvas.width = width;
    canvas.height = height;

    // Draw sample background (gradient)
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#4F46E5');
    gradient.addColorStop(1, '#7C3AED');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Draw sample content
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.fillRect(50, 50, 300, 200);
    ctx.fillStyle = 'white';
    ctx.font = '20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Sample Image', width / 2, height / 2);

    if (!watermarkConfig.enabled) return;

    // Calculate watermark text
    let watermarkText = watermarkConfig.text || 'Watermark';
    if (watermarkConfig.includeUser) {
      watermarkText += ' | user@example.com';
    }
    if (watermarkConfig.includeTimestamp) {
      const date = new Date().toISOString().split('T')[0];
      watermarkText += ` | ${date}`;
    }

    // Calculate font size (proportional to canvas)
    const fontSize = Math.floor(height * 0.05);
    ctx.font = `${fontSize}px Arial`;
    ctx.globalAlpha = watermarkConfig.opacity;
    ctx.fillStyle = watermarkConfig.textColor;

    // Calculate position
    const padding = 10;
    const textWidth = ctx.measureText(watermarkText).width;
    const textHeight = fontSize;

    let x, y;
    switch (watermarkConfig.position) {
      case 'top-left':
        x = padding;
        y = padding + textHeight;
        ctx.textAlign = 'left';
        break;
      case 'top-right':
        x = width - padding - textWidth;
        y = padding + textHeight;
        ctx.textAlign = 'right';
        break;
      case 'bottom-left':
        x = padding;
        y = height - padding;
        ctx.textAlign = 'left';
        break;
      case 'bottom-right':
        x = width - padding - textWidth;
        y = height - padding;
        ctx.textAlign = 'right';
        break;
      case 'center':
        x = width / 2;
        y = height / 2;
        ctx.textAlign = 'center';
        break;
      default:
        x = width - padding - textWidth;
        y = height - padding;
        ctx.textAlign = 'right';
    }

    // Draw watermark with shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;

    // Draw logo if present (simple representation)
    if (watermarkConfig.logo) {
      const logoSize = fontSize * 1.5;
      ctx.fillStyle = watermarkConfig.textColor;
      ctx.fillRect(
        x - (ctx.textAlign === 'right' ? textWidth + logoSize + 5 : 0),
        y - logoSize,
        logoSize,
        logoSize
      );
    }

    ctx.fillText(watermarkText, x, y);
    ctx.globalAlpha = 1.0;
  };

  const positions = [
    { value: 'top-left', label: 'Top Left', icon: 'arrow-up-left' },
    { value: 'top-right', label: 'Top Right', icon: 'arrow-up-right' },
    { value: 'bottom-left', label: 'Bottom Left', icon: 'arrow-down-left' },
    { value: 'bottom-right', label: 'Bottom Right', icon: 'arrow-down-right' },
    { value: 'center', label: 'Center', icon: 'view-grid' }
  ];

  return (
    <div className="space-y-6">
      {/* Enable Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('admin.watermark.enabled', 'Enable Watermark')}
          </label>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('admin.watermark.enabledHelp', 'Apply watermark to all generated images')}
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={watermarkConfig.enabled}
            onChange={e => handleChange('enabled', e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
        </label>
      </div>

      {watermarkConfig.enabled && (
        <>
          {/* Watermark Text */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.watermark.text', 'Watermark Text')}
            </label>
            <input
              type="text"
              value={watermarkConfig.text}
              onChange={e => handleChange('text', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white"
              placeholder={t('admin.watermark.textPlaceholder', 'Enter watermark text')}
            />
          </div>

          {/* Logo Upload */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.watermark.logo', 'Logo (SVG or PNG)')}
            </label>
            <div className="flex items-center space-x-3">
              {watermarkConfig.logo && (
                <div className="flex items-center space-x-2">
                  <div className="w-12 h-12 border border-gray-300 dark:border-gray-600 rounded flex items-center justify-center overflow-hidden">
                    {watermarkConfig.logo.startsWith('data:image/') ? (
                      <img
                        src={watermarkConfig.logo}
                        alt="Logo"
                        className="max-w-full max-h-full"
                      />
                    ) : (
                      <Icon icon="photograph" className="w-6 h-6 text-gray-400" />
                    )}
                  </div>
                  <button
                    onClick={handleRemoveLogo}
                    className="px-3 py-1 text-sm text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  >
                    {t('common.remove', 'Remove')}
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".svg,.png"
                onChange={handleLogoUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                {watermarkConfig.logo ? t('common.change', 'Change') : t('common.upload', 'Upload')}
              </button>
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t('admin.watermark.logoHelp', 'Upload SVG or PNG logo (will be stored as base64)')}
            </p>
          </div>

          {/* Position Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.watermark.position', 'Position')}
            </label>
            <div className="grid grid-cols-5 gap-2">
              {positions.map(pos => (
                <button
                  key={pos.value}
                  onClick={() => handleChange('position', pos.value)}
                  className={`px-3 py-2 border rounded-md text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    watermarkConfig.position === pos.value
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                  }`}
                >
                  <div className="flex flex-col items-center space-y-1">
                    <Icon icon={pos.icon} className="w-5 h-5" />
                    <span className="text-xs">{pos.label}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Opacity Slider */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.watermark.opacity', 'Opacity')}: {Math.round(watermarkConfig.opacity * 100)}
              %
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={watermarkConfig.opacity}
              onChange={e => handleChange('opacity', parseFloat(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
            />
          </div>

          {/* Text Color */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.watermark.textColor', 'Text Color')}
            </label>
            <div className="flex items-center space-x-3">
              <input
                type="color"
                value={watermarkConfig.textColor}
                onChange={e => handleChange('textColor', e.target.value)}
                className="h-10 w-20 border border-gray-300 dark:border-gray-600 rounded cursor-pointer"
              />
              <input
                type="text"
                value={watermarkConfig.textColor}
                onChange={e => handleChange('textColor', e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white"
                placeholder="#ffffff"
              />
            </div>
          </div>

          {/* Additional Options */}
          <div className="space-y-3">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="includeUser"
                checked={watermarkConfig.includeUser}
                onChange={e => handleChange('includeUser', e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label
                htmlFor="includeUser"
                className="ml-2 block text-sm text-gray-700 dark:text-gray-300"
              >
                {t('admin.watermark.includeUser', 'Include username in watermark')}
              </label>
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                id="includeTimestamp"
                checked={watermarkConfig.includeTimestamp}
                onChange={e => handleChange('includeTimestamp', e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label
                htmlFor="includeTimestamp"
                className="ml-2 block text-sm text-gray-700 dark:text-gray-300"
              >
                {t('admin.watermark.includeTimestamp', 'Include timestamp in watermark')}
              </label>
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                id="enableC2PA"
                checked={watermarkConfig.enableC2PA}
                onChange={e => handleChange('enableC2PA', e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label
                htmlFor="enableC2PA"
                className="ml-2 block text-sm text-gray-700 dark:text-gray-300"
              >
                {t('admin.watermark.enableC2PA', 'Enable C2PA provenance signing')}
              </label>
            </div>
          </div>

          {/* Installation ID (optional) */}
          {level === 'platform' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('admin.watermark.installationId', 'Installation ID (Optional)')}
              </label>
              <input
                type="text"
                value={watermarkConfig.installationId || ''}
                onChange={e => handleChange('installationId', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white"
                placeholder={t('admin.watermark.installationIdPlaceholder', 'e.g., production-01')}
              />
            </div>
          )}

          {/* Live Preview */}
          {showPreview && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('admin.watermark.preview', 'Live Preview')}
              </label>
              <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
                <canvas
                  ref={canvasRef}
                  className="w-full"
                  style={{ imageRendering: 'crisp-edges' }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default WatermarkConfig;
