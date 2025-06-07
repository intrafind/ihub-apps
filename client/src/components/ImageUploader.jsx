import React from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import Uploader from './Uploader';
import './ImageUpload.css';

/**
 * Lightweight wrapper for uploading images.
 */
const ImageUploader = ({ onImageSelect, disabled = false, imageData = null }) => {
  const { t } = useTranslation();
  const MAX_FILE_SIZE_MB = 10;
  const SUPPORTED_FORMATS = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

  const processImage = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const previewUrl = URL.createObjectURL(file);
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          const MAX_DIMENSION = 1024;
          if (width > height && width > MAX_DIMENSION) {
            height = Math.round((height * MAX_DIMENSION) / width);
            width = MAX_DIMENSION;
          } else if (height > MAX_DIMENSION) {
            width = Math.round((width * MAX_DIMENSION) / height);
            height = MAX_DIMENSION;
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          const base64 = canvas.toDataURL('image/jpeg', 0.8);

          resolve({
            preview: previewUrl,
            data: {
              base64,
              fileName: file.name,
              fileSize: file.size,
              fileType: file.type,
              width,
              height,
            }
          });
        };
        img.onerror = () => reject(new Error('invalid-image'));
        img.src = e.target.result;
      };

      reader.onerror = () => reject(new Error('read-error'));
      reader.readAsDataURL(file);
    });
  };

  const getErrorMessage = (code) => {
    switch (code) {
      case 'file-too-large':
        return t('errors.fileTooLarge', {
          maxSize: MAX_FILE_SIZE_MB,
          defaultValue: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`
        });
      case 'unsupported-format':
        return t('errors.unsupportedFormat', {
          formats: SUPPORTED_FORMATS.map(f => f.replace('image/', '.')).join(', '),
          defaultValue: `Unsupported file format. Please use: ${SUPPORTED_FORMATS.map(f => f.replace('image/', '.')).join(', ')}`
        });
      case 'invalid-image':
        return t('errors.invalidImage', 'Invalid image file');
      case 'read-error':
        return t('errors.readError', 'Error reading file');
      default:
        return t('errors.fileProcessingError', 'Error processing file. Please try again.');
    }
  };

  return (
    <Uploader
      accept={SUPPORTED_FORMATS}
      maxSizeMB={MAX_FILE_SIZE_MB}
      disabled={disabled}
      onSelect={onImageSelect}
      onProcessFile={processImage}
      data={imageData}
    >
      {({ preview, error, isProcessing, handleButtonClick, handleClear, inputProps }) => (
        <div className="image-uploader">
          <input {...inputProps} />
          {preview ? (
            <div className="relative mt-2 mb-4">
              <div className="relative rounded-lg overflow-hidden border border-gray-300">
                <img
                  src={preview}
                  alt="Preview"
                  className="max-w-full max-h-60 mx-auto"
                />
                <button
                  type="button"
                  onClick={handleClear}
                  className="absolute top-2 right-2 bg-gray-800 bg-opacity-70 text-white rounded-full p-1 hover:bg-opacity-90"
                  title={t('common.remove', 'Remove image')}
                >
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
              <div className="text-xs text-gray-500 mt-1 text-center">
                {t('components.imageUploader.imageSelected', 'Image selected')}
              </div>
            </div>
          ) : (
            <div className="mt-2 mb-4">
              <button
                type="button"
                onClick={handleButtonClick}
                disabled={disabled || isProcessing}
                className={`flex items-center justify-center w-full p-3 border-2 border-dashed rounded-lg ${
                  disabled || isProcessing
                    ? 'border-gray-300 bg-gray-100 text-gray-400 cursor-not-allowed'
                    : 'border-gray-400 hover:border-indigo-500 hover:text-indigo-500'
                }`}
              >
                <Icon name="camera" className="mr-2" />
                <span>{t('components.imageUploader.uploadImage', 'Upload Image')}</span>
              </button>

              {error && (
                <div className="text-red-500 text-sm mt-1">
                  {getErrorMessage(error)}
                </div>
              )}

              <div className="text-xs text-gray-500 mt-1 text-center">
                {t('components.imageUploader.supportedFormats', 'Supported: JPG, PNG, GIF, WebP (max {{maxSize}}MB)', {
                  maxSize: MAX_FILE_SIZE_MB
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </Uploader>
  );
};

export default ImageUploader;
