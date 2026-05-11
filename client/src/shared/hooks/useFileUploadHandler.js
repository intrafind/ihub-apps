import { useState } from 'react';

/**
 * Custom hook for handling file uploads in chat applications.
 * Manages file selection state and creates upload configurations from app settings.
 * @returns {Object} File upload utilities
 * @returns {Object|null} returns.selectedFile - Currently selected file data
 * @returns {boolean} returns.showUploader - Whether uploader UI is visible
 * @returns {Function} returns.handleFileSelect - Handle file selection (fileData) => void
 * @returns {Function} returns.toggleUploader - Toggle uploader visibility () => void
 * @returns {Function} returns.createUploadConfig - Create upload config from app settings (app, modelObject) => Object
 * @returns {Function} returns.clearSelectedFile - Clear the selected file () => void
 * @returns {Function} returns.hideUploader - Hide the uploader UI () => void
 * @returns {Function} returns.setSelectedFile - Direct state setter for selected file
 * @returns {Function} returns.setShowUploader - Direct state setter for uploader visibility
 */
export function useFileUploadHandler() {
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
    const audioConfig = uploadConfig?.audioUpload || {};
    const videoConfig = uploadConfig?.videoUpload || {};
    const fileConfig = uploadConfig?.fileUpload || {};
    const cloudStorageConfig = uploadConfig?.cloudStorageUpload || {};

    // Local upload covers paper-clip / drag-and-drop file selection
    const localUploadEnabled =
      uploadConfig?.enabled !== false &&
      (imageConfig?.enabled === true ||
        audioConfig?.enabled === true ||
        videoConfig?.enabled === true ||
        fileConfig?.enabled === true);

    // Cloud storage is offered through the actions menu and can be enabled
    // independently from local file upload (issue #1426).
    const cloudStorageUploadEnabled =
      uploadConfig?.enabled !== false && cloudStorageConfig?.enabled === true;

    if (!localUploadEnabled && !cloudStorageUploadEnabled) {
      return { enabled: false, localUploadEnabled: false };
    }

    if (!localUploadEnabled) {
      // Only cloud storage uploads are available — skip local-upload specific
      // computations and return a minimal config that still exposes cloud info.
      return {
        enabled: true,
        localUploadEnabled: false,
        cloudStorageUpload: { ...cloudStorageConfig, enabled: true }
      };
    }

    // Determine if image upload should be disabled based on model capabilities
    // Use model metadata (supportsVision/supportsImages) if available, fallback to name heuristics
    const modelId = selectedModel?.id || '';
    const isVisionModel =
      selectedModel?.supportsVision ??
      selectedModel?.supportsImages ??
      (modelId &&
        (modelId.includes('vision') ||
          modelId.includes('gpt-4') ||
          modelId.includes('claude-3') ||
          modelId.includes('gemini') ||
          modelId.includes('4o')));

    // Determine if audio upload should be disabled based on model capabilities
    const isAudioModel = selectedModel?.supportsAudio === true;

    const imageUploadEnabled = imageConfig?.enabled !== false && isVisionModel;
    const audioUploadEnabled = audioConfig?.enabled !== false && isAudioModel;
    const videoUploadEnabled = videoConfig?.enabled !== false && isAudioModel; // Video requires audio support
    const fileUploadEnabled = fileConfig?.enabled !== false;

    return {
      enabled: true,
      localUploadEnabled: true,
      imageUploadEnabled,
      audioUploadEnabled,
      videoUploadEnabled,
      fileUploadEnabled,
      allowMultiple: uploadConfig?.allowMultiple || false,
      maxFileSizeMB:
        Math.max(
          imageConfig?.maxFileSizeMB || 0,
          audioConfig?.maxFileSizeMB || 0,
          videoConfig?.maxFileSizeMB || 0,
          fileConfig?.maxFileSizeMB || 0
        ) || 10,
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
      // Audio-specific settings
      audioUpload: {
        enabled: audioUploadEnabled,
        maxFileSizeMB: audioConfig?.maxFileSizeMB || 20,
        supportedFormats: audioConfig?.supportedFormats || [
          'audio/mpeg',
          'audio/mp3',
          'audio/wav',
          'audio/flac',
          'audio/ogg',
          'audio/mp4'
        ]
      },
      // Video-specific settings
      videoUpload: {
        enabled: videoUploadEnabled,
        extractAudio: videoConfig?.extractAudio !== false,
        maxFileSizeMB: videoConfig?.maxFileSizeMB || 50,
        supportedFormats: videoConfig?.supportedFormats || [
          'video/mp4',
          'video/webm',
          'video/quicktime'
        ]
      },
      // File-specific settings
      fileUpload: {
        enabled: fileUploadEnabled,
        maxFileSizeMB: fileConfig?.maxFileSizeMB || 5,
        supportedFormats: fileConfig?.supportedFormats || [
          'text/plain',
          'text/markdown',
          'text/csv',
          'application/json',
          'text/html',
          'text/css',
          'text/javascript',
          'application/javascript',
          'application/pdf'
        ]
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
      supportedAudioFormats: audioUploadEnabled
        ? audioConfig?.supportedFormats || [
            'audio/mpeg',
            'audio/mp3',
            'audio/wav',
            'audio/flac',
            'audio/ogg',
            'audio/mp4'
          ]
        : [],
      supportedVideoFormats: videoUploadEnabled
        ? videoConfig?.supportedFormats || ['video/mp4', 'video/webm', 'video/quicktime']
        : [],
      extractAudioFromVideo: videoConfig?.extractAudio !== false,
      supportedFormats: fileUploadEnabled
        ? fileConfig?.supportedFormats || [
            'text/plain',
            'text/markdown',
            'text/csv',
            'application/json',
            'text/html',
            'text/css',
            'text/javascript',
            'application/javascript',
            'application/pdf'
          ]
        : [],
      // Cloud storage upload settings
      cloudStorageUpload: { ...cloudStorageConfig, enabled: cloudStorageUploadEnabled }
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
}

export default useFileUploadHandler;
