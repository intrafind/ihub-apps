import { useState } from 'react';

export const useFileUploadHandler = () => {
  const [selectedFile, setSelectedFile] = useState(null);
  const [showUploader, setShowUploader] = useState(false);

  // Handle file selection from UnifiedUploader (handles both images and files)
  const handleFileSelect = fileData => {
    console.log('useFileUploadHandler: handleFileSelect called with', fileData);
    setSelectedFile(fileData);
  };

  // Toggle uploader visibility
  const toggleUploader = () => {
    setShowUploader(prev => !prev);
  };

  // Create unified upload configuration
  const createUploadConfig = (app, selectedModel) => {
    // New unified upload config structure
    const uploadConfig = app?.upload || {};

    // Get upload config from unified structure only
    const imageConfig = uploadConfig?.imageUpload || {};
    const fileConfig = uploadConfig?.fileUpload || {};

    // Check if upload is enabled at all
    const uploadEnabled =
      uploadConfig?.enabled !== false &&
      (imageConfig?.enabled === true || fileConfig?.enabled === true);

    if (!uploadEnabled) {
      return { enabled: false };
    }

    // Determine if image upload should be disabled based on model capabilities
    // Models that don't support vision: check if model name suggests it lacks vision
    const isVisionModel =
      selectedModel &&
      (selectedModel.includes('vision') ||
        selectedModel.includes('gpt-4') ||
        selectedModel.includes('claude-3') ||
        selectedModel.includes('gemini') ||
        selectedModel.includes('4o'));

    const imageUploadEnabled = imageConfig?.enabled !== false && isVisionModel;
    const fileUploadEnabled = fileConfig?.enabled !== false;

    return {
      enabled: true,
      imageUploadEnabled,
      fileUploadEnabled,
      allowMultiple: uploadConfig?.allowMultiple || false,
      maxFileSizeMB:
        Math.max(imageConfig?.maxFileSizeMB || 0, fileConfig?.maxFileSizeMB || 0) || 10,
      // Image-specific settings
      imageUpload: {
        enabled: imageUploadEnabled,
        resizeImages: imageConfig?.resizeImages !== false,
        maxResizeDimension: imageConfig?.maxResizeDimension || 1024,
        supportedFormats: imageConfig?.supportedFormats || [
          'image/jpeg',
          'image/jpg',
          'image/png',
          'image/gif',
          'image/webp'
        ],
        maxFileSizeMB: imageConfig?.maxFileSizeMB || 10
      },
      // File-specific settings
      fileUpload: {
        enabled: fileUploadEnabled,
        maxFileSizeMB: fileConfig?.maxFileSizeMB || 5,
        supportedTextFormats: fileConfig?.supportedTextFormats || [
          'text/plain',
          'text/markdown',
          'text/csv',
          'application/json',
          'text/html',
          'text/css',
          'text/javascript',
          'application/javascript'
        ],
        supportedPdfFormats: fileConfig?.supportedPdfFormats || ['application/pdf']
      },
      // Unified format fields for backward compatibility with components
      resizeImages: imageConfig?.resizeImages !== false,
      maxResizeDimension: imageConfig?.maxResizeDimension || 1024,
      supportedImageFormats: imageUploadEnabled
        ? imageConfig?.supportedFormats || [
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/gif',
            'image/webp'
          ]
        : [],
      supportedTextFormats: fileUploadEnabled
        ? fileConfig?.supportedTextFormats || [
            'text/plain',
            'text/markdown',
            'text/csv',
            'application/json',
            'text/html',
            'text/css',
            'text/javascript',
            'application/javascript'
          ]
        : [],
      supportedPdfFormats: fileUploadEnabled
        ? fileConfig?.supportedPdfFormats || ['application/pdf']
        : []
    };
  };

  // Clear selected file
  const clearSelectedFile = () => {
    setSelectedFile(null);
  };

  // Hide uploader
  const hideUploader = () => {
    setShowUploader(false);
  };

  return {
    selectedFile,
    showUploader,
    handleFileSelect,
    toggleUploader,
    createUploadConfig,
    clearSelectedFile,
    hideUploader,
    setSelectedFile,
    setShowUploader
  };
};

export default useFileUploadHandler;
