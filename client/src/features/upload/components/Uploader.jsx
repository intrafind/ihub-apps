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

  const handleFileChange = async e => {
    const files = allowMultiple ? Array.from(e.target.files) : [e.target.files[0]];
    setError(null);
    if (!files.length || !files[0]) return;

    // Validate all files first
    for (const file of files) {
      if (file.size > maxSizeMB * 1024 * 1024) {
        setError('file-too-large');
        return;
      }

      if (accept.length && !accept.includes(file.type)) {
        setError('unsupported-format');
        return;
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
            results.push(result);
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
          setPreview(result.preview || null);
          if (onSelect) {
            onSelect(result.data);
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

  return children({
    preview,
    error,
    isProcessing,
    handleButtonClick,
    handleClear,
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
