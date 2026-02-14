import { useState, useRef, useEffect } from 'react';

/**
 * Generic uploader component that handles file selection, validation and preview logic.
 * UI rendering is delegated to a render prop for flexibility.
 */
const Uploader = ({
  accept = [],
  maxSizeMB = 10,
  disabled = false,
  data = null,
  onSelect,
  onProcessFile,
  allowMultiple = false,
  children
}) => {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  // Reset preview when parent clears the data
  useEffect(() => {
    if (data === null && preview !== null) {
      setPreview(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [data, preview]);

  const processFiles = async files => {
    setError(null);
    if (!files.length || !files[0]) return;

    // Filter accept array to only include MIME types (not file extensions like .pdf, .msg)
    const acceptedMimeTypes = accept.filter(item => !item.startsWith('.'));

    // Validate all files first
    for (const file of files) {
      console.log('File validation:', { name: file.name, type: file.type, size: file.size });

      if (file.size > maxSizeMB * 1024 * 1024) {
        setError('file-too-large');
        return;
      }

      // Check if file type is in accepted MIME types
      // Note: Some browsers may return empty string or incorrect MIME type for certain files
      // In such cases, we can fall back to extension-based validation
      const hasValidMimeType =
        acceptedMimeTypes.length === 0 || acceptedMimeTypes.includes(file.type);

      if (!hasValidMimeType) {
        // If MIME type doesn't match, try checking file extension as fallback
        const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
        const hasValidExtension = accept.some(
          item => item.startsWith('.') && item === fileExtension
        );

        if (!hasValidExtension) {
          console.error('File validation failed:', {
            fileName: file.name,
            fileType: file.type,
            fileExtension,
            acceptedMimeTypes,
            acceptedExtensions: accept.filter(item => item.startsWith('.'))
          });
          setError('unsupported-format');
          return;
        }
        console.log('File accepted via extension fallback:', fileExtension);
      }
    }

    if (!onProcessFile) {
      return;
    }

    try {
      setIsProcessing(true);

      if (allowMultiple) {
        // Process multiple files
        const results = [];
        for (const file of files) {
          const result = await onProcessFile(file);
          if (result && typeof result === 'object') {
            // Check if this is a multipage TIFF that returned multiple results
            if (result.multipleResults && Array.isArray(result.multipleResults)) {
              // Add all pages from multipage TIFF
              results.push(...result.multipleResults);
            } else {
              results.push(result);
            }
          }
        }

        if (results.length > 0) {
          setPreview(results.map(r => r.preview || null));
          if (onSelect) {
            onSelect(results.map(r => r.data));
          }
        }
      } else {
        // Process single file (legacy behavior)
        const result = await onProcessFile(files[0]);
        if (result && typeof result === 'object') {
          // Check if this is a multipage TIFF that returned multiple results
          if (result.multipleResults && Array.isArray(result.multipleResults)) {
            // For single file mode with multipage TIFF, use only the first page
            const firstResult = result.multipleResults[0];
            setPreview(firstResult.preview || null);
            if (onSelect) {
              onSelect(firstResult.data);
            }
          } else {
            setPreview(result.preview || null);
            if (onSelect) {
              onSelect(result.data);
            }
          }
        }
      }
    } catch (err) {
      console.error('Error processing file:', err);
      setError(err.message || 'processing-error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileChange = async e => {
    const files = allowMultiple ? Array.from(e.target.files) : [e.target.files[0]];
    await processFiles(files);
  };

  const handleButtonClick = () => {
    if (fileInputRef.current && !isProcessing) {
      fileInputRef.current.click();
    }
  };

  const handleClear = () => {
    setPreview(null);
    setError(null);
    setIsProcessing(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (onSelect) {
      onSelect(null);
    }
  };

  const handleDragEnter = e => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && !isProcessing) {
      setDragCounter(prev => prev + 1);
      setIsDragging(true);
    }
  };

  const handleDragLeave = e => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && !isProcessing) {
      setDragCounter(prev => {
        const newCount = prev - 1;
        if (newCount === 0) {
          setIsDragging(false);
        }
        return newCount;
      });
    }
  };

  const handleDragOver = e => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async e => {
    e.preventDefault();
    e.stopPropagation();
    setDragCounter(0);
    setIsDragging(false);

    if (disabled || isProcessing) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // Process files using the same logic as file input
    await processFiles(allowMultiple ? files : [files[0]]);
  };

  return children({
    preview,
    error,
    isProcessing,
    isDragging,
    handleButtonClick,
    handleClear,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    inputProps: {
      type: 'file',
      ref: fileInputRef,
      onChange: handleFileChange,
      accept: accept.join(','),
      disabled: disabled || isProcessing,
      className: 'hidden',
      multiple: allowMultiple
    }
  });
};

export default Uploader;
