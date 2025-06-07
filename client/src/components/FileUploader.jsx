import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import pdf2md from '@opendocsg/pdf2md';

/**
 * Component for handling file uploads in the chat interface
 * Supports text files and PDF files (converted to markdown)
 */
const FileUploader = ({ 
  onFileSelect, 
  disabled = false, 
  fileData = null,
  config = {} 
}) => {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef(null);
  
  // Configuration for file uploads with defaults
  const MAX_FILE_SIZE_MB = config.maxFileSizeMB || 10;
  const SUPPORTED_TEXT_FORMATS = config.supportedTextFormats || [
    'text/plain', 
    'text/markdown', 
    'text/csv', 
    'application/json', 
    'text/html', 
    'text/css', 
    'text/javascript', 
    'application/javascript'
  ];
  const SUPPORTED_PDF_FORMATS = config.supportedPdfFormats || ['application/pdf'];
  const ALL_SUPPORTED_FORMATS = [...SUPPORTED_TEXT_FORMATS, ...SUPPORTED_PDF_FORMATS];
  
  // Reset the preview ONLY when the parent component explicitly sets fileData to null
  // This ensures the file is only cleared when sending a message, not when the component is rendered
  useEffect(() => {
    console.log('FileUploader: fileData changed to', fileData);
    
    // Only clear if fileData is explicitly set to null (meaning a message was sent)
    if (fileData === null && preview !== null) {
      console.log('Clearing preview due to fileData being null');
      setPreview(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [fileData, preview]);
  
  /**
   * Handle file selection
   * @param {Event} e - The file input change event
   */
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    console.log('File selected:', file);
    setError(null);
    setIsProcessing(false);
    
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
    if (!ALL_SUPPORTED_FORMATS.includes(file.type)) {
      console.log('Unsupported file format:', file.type);
      console.log('Supported formats:', ALL_SUPPORTED_FORMATS);
      
      // Generate human-readable format list
      const textFormats = SUPPORTED_TEXT_FORMATS.map(format => {
        switch(format) {
          case 'text/plain': return 'TXT';
          case 'text/markdown': return 'MD';
          case 'text/csv': return 'CSV';
          case 'application/json': return 'JSON';
          case 'text/html': return 'HTML';
          case 'text/css': return 'CSS';
          case 'text/javascript':
          case 'application/javascript': return 'JS';
          case 'text/xml': return 'XML';
          default: return format;
        }
      });
      const pdfFormats = SUPPORTED_PDF_FORMATS.map(format => format === 'application/pdf' ? 'PDF' : format);
      const allFormats = [...new Set([...textFormats, ...pdfFormats])].join(', ');
      
      setError(t('errors.unsupportedFileFormat', {
        formats: allFormats,
        defaultValue: `Unsupported file format. Please use: {{formats}}`
      }));
      return;
    }
    
    // Process the valid file
    console.log('Processing file:', file.name);
    processFile(file);
  };
  
  /**
   * Process file based on its type
   * @param {File} file - The file to process
   */
  const processFile = async (file) => {
    setIsProcessing(true);
    
    try {
      let content = '';
      let processedContent = '';
      
      if (SUPPORTED_PDF_FORMATS.includes(file.type)) {
        // Process PDF file
        console.log('Processing PDF file');
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        // Convert PDF to markdown
        processedContent = await pdf2md(uint8Array);
        content = processedContent;
        
        // Create a preview for the UI
        const previewContent = content.length > 200 ? content.substring(0, 200) + '...' : content;
        setPreview({
          fileName: file.name,
          fileType: 'PDF',
          content: previewContent,
          fullContent: content
        });
        
      } else if (SUPPORTED_TEXT_FORMATS.includes(file.type)) {
        // Process text file
        console.log('Processing text file');
        content = await readTextFile(file);
        processedContent = content;
        
        // Create a preview for the UI
        const previewContent = content.length > 200 ? content.substring(0, 200) + '...' : content;
        setPreview({
          fileName: file.name,
          fileType: getFileTypeDisplay(file.type),
          content: previewContent,
          fullContent: content
        });
      }
      
      // Send the processed file to the parent component
      console.log('Calling onFileSelect with file data');
      onFileSelect({
        content: processedContent,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        displayType: getFileTypeDisplay(file.type)
      });
      
    } catch (error) {
      console.error('Error processing file:', error);
      setError(t('errors.fileProcessingError', 'Error processing file. Please try again.'));
    } finally {
      setIsProcessing(false);
    }
  };
  
  /**
   * Read text file content
   * @param {File} file - The text file to read
   * @returns {Promise<string>} - The file content
   */
  const readTextFile = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = (e) => {
        resolve(e.target.result);
      };
      
      reader.onerror = () => {
        reject(new Error(t('errors.readError', 'Error reading file')));
      };
      
      reader.readAsText(file);
    });
  };
  
  /**
   * Get display type for file
   * @param {string} mimeType - The MIME type
   * @returns {string} - Display type
   */
  const getFileTypeDisplay = (mimeType) => {
    switch (mimeType) {
      case 'text/plain': return 'TXT';
      case 'text/markdown': return 'MD';
      case 'text/csv': return 'CSV';
      case 'application/json': return 'JSON';
      case 'text/html': return 'HTML';
      case 'text/css': return 'CSS';
      case 'text/javascript':
      case 'application/javascript': return 'JS';
      case 'application/pdf': return 'PDF';
      default: return 'FILE';
    }
  };
  
  /**
   * Trigger file selection dialog
   */
  const handleButtonClick = () => {
    if (fileInputRef.current && !isProcessing) {
      fileInputRef.current.click();
    }
  };
  
  /**
   * Clear the selected file
   */
  const handleClearFile = () => {
    setPreview(null);
    setError(null);
    setIsProcessing(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onFileSelect(null);
  };
  
  return (
    <div className="file-uploader">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept={ALL_SUPPORTED_FORMATS.join(',')}
        className="hidden"
        disabled={disabled || isProcessing}
      />
      
      {preview ? (
        <div className="relative mt-2 mb-4">
          <div className="relative rounded-lg overflow-hidden border border-gray-300 p-3 bg-gray-50">
            <div className="flex items-start gap-3">
              <Icon name="document-text" className="w-8 h-8 text-blue-500 flex-shrink-0 mt-1" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-gray-900 truncate">
                  {preview.fileName}
                </div>
                <div className="text-xs text-gray-500 mb-2">
                  {preview.fileType} file
                </div>
                <div className="text-xs text-gray-700 bg-white p-2 rounded border max-h-20 overflow-y-auto">
                  {preview.content}
                </div>
              </div>
              <button
                type="button"
                onClick={handleClearFile}
                className="bg-gray-800 bg-opacity-70 text-white rounded-full p-1 hover:bg-opacity-90 flex-shrink-0"
                title={t('common.remove', 'Remove file')}
              >
                <Icon name="x" className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="text-xs text-gray-500 mt-1 text-center">
            {t('components.fileUploader.fileSelected', 'File selected and processed')}
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
            {isProcessing ? (
              <>
                <div className="animate-spin h-5 w-5 mr-2 flex items-center justify-center">
                  <Icon name="refresh" className="text-current" />
                </div>
                <span>{t('components.fileUploader.processing', 'Processing file...')}</span>
              </>
            ) : (
              <>
                <Icon name="paper-clip" className="mr-2" />
                <span>{t('components.fileUploader.uploadFile', 'Upload File')}</span>
              </>
            )}
          </button>
          
          {error && (
            <div className="text-red-500 text-sm mt-1">
              {error}
            </div>
          )}
          
          <div className="text-xs text-gray-500 mt-1 text-center">
            {(() => {
              // Generate human-readable format list for display
              const textFormats = SUPPORTED_TEXT_FORMATS.map(format => {
                switch(format) {
                  case 'text/plain': return 'TXT';
                  case 'text/markdown': return 'MD';
                  case 'text/csv': return 'CSV';
                  case 'application/json': return 'JSON';
                  case 'text/html': return 'HTML';
                  case 'text/css': return 'CSS';
                  case 'text/javascript':
                  case 'application/javascript': return 'JS';
                  case 'text/xml': return 'XML';
                  default: return format;
                }
              });
              const pdfFormats = SUPPORTED_PDF_FORMATS.map(format => format === 'application/pdf' ? 'PDF' : format);
              const allFormats = [...new Set([...textFormats, ...pdfFormats])].join(', ');
              
              return t('components.fileUploader.supportedFormats', 'Supported: {{formats}} (max {{maxSize}}MB)', {
                formats: allFormats,
                maxSize: MAX_FILE_SIZE_MB
              });
            })()}
          </div>
        </div>
      )}
    </div>
  );
};

export default FileUploader;
