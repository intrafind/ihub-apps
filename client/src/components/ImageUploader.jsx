import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import "./ImageUpload.css";

/**
 * Component for handling image uploads in the chat interface
 */
const ImageUploader = ({ onImageSelect, disabled = false, imageData = null }) => {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  
  // Reset the preview ONLY when the parent component explicitly sets imageData to null
  // This ensures the image is only cleared when sending a message, not when the component is rendered
  useEffect(() => {
    console.log('ImageUploader: imageData changed to', imageData);
    
    // Only clear if imageData is explicitly set to null (meaning a message was sent)
    if (imageData === null && preview !== null) {
      console.log('Clearing preview due to imageData being null');
      setPreview(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [imageData, preview]);
  
  // Configuration for image uploads
  const MAX_FILE_SIZE_MB = 10;
  const SUPPORTED_FORMATS = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  
  // When component unmounts, revoke any created object URLs to prevent memory leaks
  useEffect(() => {
    return () => {
      // Clean up the preview URL when component unmounts
      if (preview && preview.startsWith('blob:')) {
        console.log('Revoking object URL:', preview);
        URL.revokeObjectURL(preview);
      }
    };
  }, [preview]);
  
  /**
   * Handle image file selection
   * @param {Event} e - The file input change event
   */
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    console.log('File selected:', file);
    setError(null);
    
    if (!file) {
      console.log('No file selected');
      return;
    }
    
    // Validate file size
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      console.log('File too large:', file.size);
      setError(t('errors.fileTooLarge', {
        maxSize: MAX_FILE_SIZE_MB,
        defaultValue: `File too large. Maximum size is {{maxSize}}MB.`
      }));
      return;
    }
    
    // Validate file type
    if (!SUPPORTED_FORMATS.includes(file.type)) {
      console.log('Unsupported file format:', file.type);
      setError(t('errors.unsupportedFormat', {
        formats: SUPPORTED_FORMATS.map(f => f.replace('image/', '.')).join(', '),
        defaultValue: `Unsupported file format. Please use: {{formats}}`
      }));
      return;
    }
    
    // Process the valid image
    console.log('Processing file:', file.name);
    processImage(file);
  };
  
  /**
   * Process and resize image, then create base64 encoding
   * @param {File} file - The image file to process
   */
  const processImage = (file) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const img = new Image();
      
      img.onload = () => {
        // Create preview URL for the UI - do this BEFORE canvas operations
        const previewUrl = URL.createObjectURL(file);
        console.log('Setting preview URL:', previewUrl);
        setPreview(previewUrl);
        
        // Create a canvas to resize the image if needed
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        
        // Resize if the image is too large (max 1024px on largest dimension)
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
        
        // Convert to base64 with JPEG encoding for better compression
        const base64 = canvas.toDataURL('image/jpeg', 0.8);
        
        // Send the processed image to the parent component
        console.log('Calling onImageSelect with image data');
        onImageSelect({
          base64,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          width,
          height
        });
      };
      
      img.onerror = () => {
        setError(t('errors.invalidImage', 'Invalid image file'));
      };
      
      img.src = e.target.result;
    };
    
    reader.onerror = () => {
      setError(t('errors.readError', 'Error reading file'));
    };
    
    reader.readAsDataURL(file);
  };
  
  /**
   * Trigger file selection dialog
   */
  const handleButtonClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };
  
  /**
   * Clear the selected image
   */
  const handleClearImage = () => {
    setPreview(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onImageSelect(null);
  };
  
  return (
    <div className="image-uploader">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept={SUPPORTED_FORMATS.map(format => `.${format.split('/')[1]}`).join(',')}
        className="hidden"
        disabled={disabled}
      />
      
      {preview ? (
        <div className="relative mt-2 mb-4">
          <div className="relative rounded-lg overflow-hidden border border-gray-300">
            <img 
              src={preview} 
              alt="Preview" 
              className="max-w-full max-h-60 mx-auto"
              onLoad={() => console.log('Image preview loaded successfully')}
              onError={() => console.error('Failed to load image preview')}
            />
            <button
              type="button"
              onClick={handleClearImage}
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
            disabled={disabled}
            className={`flex items-center justify-center w-full p-3 border-2 border-dashed rounded-lg ${
              disabled 
                ? 'border-gray-300 bg-gray-100 text-gray-400 cursor-not-allowed' 
                : 'border-gray-400 hover:border-indigo-500 hover:text-indigo-500'
            }`}
          >
            <Icon name="camera" className="mr-2" />
            <span>{t('components.imageUploader.uploadImage', 'Upload Image')}</span>
          </button>
          
          {error && (
            <div className="text-red-500 text-sm mt-1">
              {error}
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
  );
};

export default ImageUploader;
