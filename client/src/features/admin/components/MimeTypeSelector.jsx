import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchMimetypesConfig } from '../../../api/endpoints/config';

/**
 * MimeTypeSelector - Component for selecting MIME types by category or individually
 * @param {Object} props
 * @param {string} props.categoryType - Type of category: 'images', 'audio', 'video', 'documents'
 * @param {string[]} props.selectedFormats - Currently selected MIME types
 * @param {Function} props.onChange - Callback when selection changes
 * @param {string[]} props.defaultFormats - Default formats to use if none selected
 */
const MimeTypeSelector = ({ categoryType, selectedFormats = [], onChange, defaultFormats = [] }) => {
  const { t } = useTranslation();
  const [mimetypesConfig, setMimetypesConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [useCategory, setUseCategory] = useState(false);

  useEffect(() => {
    fetchMimetypesConfig()
      .then(config => {
        setMimetypesConfig(config);
        setLoading(false);
      })
      .catch(error => {
        console.error('Failed to load mimetypes config:', error);
        setLoading(false);
      });
  }, []);

  if (loading || !mimetypesConfig) {
    return (
      <div className="text-xs text-gray-500">
        {t('admin.apps.edit.loadingFormats', 'Loading available formats...')}
      </div>
    );
  }

  const category = mimetypesConfig.categories[categoryType];
  if (!category) {
    return (
      <div className="text-xs text-red-500">
        {t('admin.apps.edit.categoryNotFound', 'Category not found')}
      </div>
    );
  }

  const availableMimeTypes = category.mimeTypes || [];

  const handleCategoryToggle = checked => {
    setUseCategory(checked);
    if (checked) {
      // Select all MIME types in the category
      onChange(availableMimeTypes);
    } else {
      // Use default formats or keep current selection
      onChange(selectedFormats.length > 0 ? selectedFormats : defaultFormats);
    }
  };

  const handleMimeTypeToggle = (mimeType, checked) => {
    const newFormats = checked
      ? [...selectedFormats.filter(f => f !== mimeType), mimeType]
      : selectedFormats.filter(f => f !== mimeType);
    onChange(newFormats);
  };

  const isAllSelected =
    selectedFormats.length === availableMimeTypes.length &&
    availableMimeTypes.every(mt => selectedFormats.includes(mt));

  return (
    <div className="space-y-2">
      <div className="flex items-center mb-3 p-2 bg-indigo-50 rounded">
        <input
          type="checkbox"
          checked={useCategory || isAllSelected}
          onChange={e => handleCategoryToggle(e.target.checked)}
          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
        />
        <label className="ml-2 block text-xs font-medium text-indigo-900">
          {t(
            'admin.apps.edit.useEntireCategory',
            `Use entire ${category.name?.en || categoryType} category`
          )}
        </label>
      </div>

      {!useCategory && (
        <div className="space-y-1">
          <p className="text-xs text-gray-500 mb-2">
            {t('admin.apps.edit.selectIndividualFormats', 'Or select individual formats:')}
          </p>
          {availableMimeTypes.map(mimeType => {
            const mimeTypeDetails = mimetypesConfig.mimeTypes[mimeType];
            const displayName = mimeTypeDetails?.displayName || mimeType;
            const extensions = mimeTypeDetails?.extensions?.join(', ') || '';

            return (
              <div key={mimeType} className="flex items-center">
                <input
                  type="checkbox"
                  checked={selectedFormats.includes(mimeType)}
                  onChange={e => handleMimeTypeToggle(mimeType, e.target.checked)}
                  className="h-3 w-3 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label className="ml-2 block text-xs text-gray-700">
                  {displayName}
                  {extensions && <span className="text-gray-400 ml-1">({extensions})</span>}
                </label>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default MimeTypeSelector;
