// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useRef, useEffect, useCallback } from 'react';
import { canonicalMimeType } from '../utils/fileProcessing';
import { isAbortError, raceAbort } from '../../../utils/abortable';

/**
 * Generic uploader component that handles file selection, validation and preview logic.
 * UI rendering is delegated to a render prop for flexibility.
 *
 * `acceptAnyFile` skips the MIME/extension check (size is still enforced) and
 * leaves the file picker unfiltered — for callers that decide acceptance by
 * content in `onProcessFile`, e.g. "any text file" uploads.
 *
 * `onProcessFile(file, { signal, onProgress })` may use its second argument: it
 * stops when `signal` aborts and reports `onProgress({ stage, percent, detail })`
 * (`percent` null when unknown, `detail` optional: what is being worked on,
 * `{ unit: 'page'|'slide', current, total }`). The render prop gets that as
 * `progress`, `{ fileName, stage, percent, detail?, index, total }` (`index`
 * counts from 0 within the batch), and `cancelProcessing()` to stop. Stopping
 * is not an error: nothing is attached for the file being processed, files
 * attached before stay, and so do the files of the batch that were done.
 * `handleClear()` and unmounting are not a stop but a discard: the run
 * publishes nothing.
 * `onProcessingChange(true|false)` follows `isProcessing`, for a parent that
 * must not act on an attachment still on its way (e.g. send).
 *
 * `maxSizeMB` is the gate every file passes. A processor holding a file to a
 * lower limit of its own (per file type) throws an Error with the message
 * `file-too-large` and `params: { maxSizeMB }`; the render prop gets `error` and
 * those `errorParams`.
 */
const Uploader = ({
  accept = [],
  maxSizeMB = 10,
  disabled = false,
  data = null,
  onSelect,
  onProcessFile,
  allowMultiple = false,
  acceptAnyFile = false,
  onProcessingChange,
  children
}) => {
  const [preview, setPreview] = useState(null);
  const [fileData, setFileData] = useState(null); // Track file data separately
  const [error, setError] = useState(null);
  // What the message of `error` needs, from the error `onProcessFile` threw
  const [errorParams, setErrorParams] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [_dragCounter, setDragCounter] = useState(0);
  const fileInputRef = useRef(null);
  // Aborts the processing run in progress, if any
  const abortRef = useRef(null);
  // The runs aborted to be discarded (Clear, unmount) rather than stopped by the
  // user: whatever they had finished must not be attached after all
  const discardedRunsRef = useRef(new WeakSet());

  /** Abort the run in progress and drop what it has done so far. */
  const discardProcessing = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    discardedRunsRef.current.add(controller);
    controller.abort();
  }, []);

  // A run still going when the uploader goes away is discarded: there is no
  // composer left to attach its files to
  useEffect(() => () => discardProcessing(), [discardProcessing]);

  useEffect(() => {
    if (!isProcessing) return undefined;
    onProcessingChange?.(true);
    return () => onProcessingChange?.(false);
  }, [isProcessing, onProcessingChange]);

  // Reset preview when parent clears the data
  useEffect(() => {
    if (data === null && preview !== null) {
      setPreview(null);
      setFileData(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [data, preview]);

  // Sync preview from externally-provided data (e.g., cloud file downloads)
  useEffect(() => {
    if (data !== null && data !== undefined && preview === null) {
      // Data was set externally (cloud upload) — derive preview from it
      if (Array.isArray(data)) {
        const previews = data.map(item => {
          if (item.type === 'image') {
            return {
              type: 'image',
              url: item.base64,
              fileName: item.fileName,
              fileType: item.fileType
            };
          }
          return {
            type: item.type,
            fileName: item.fileName,
            fileType: item.fileType,
            content: item.content
          };
        });
        setPreview(previews);
      } else if (data.type === 'image') {
        setPreview({
          type: 'image',
          url: data.base64,
          fileName: data.fileName,
          fileType: data.fileType
        });
      } else {
        setPreview({
          type: data.type,
          fileName: data.fileName,
          fileType: data.fileType,
          content: data.content
        });
      }
      setFileData(data);
    }
  }, [data, preview]);

  const processFiles = async files => {
    setError(null);
    setErrorParams(null);
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
        acceptAnyFile ||
        acceptedMimeTypes.length === 0 ||
        acceptedMimeTypes.includes(file.type) ||
        acceptedMimeTypes.includes(canonicalMimeType(file.type, file.name));

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

    // One controller per run: Stop aborts it, and whatever is processing stops
    // at its next checkpoint
    const controller = new AbortController();
    const { signal } = controller;
    abortRef.current = controller;
    const isDiscarded = () => discardedRunsRef.current.has(controller);

    // Even a processor that ignores the signal is stopped as far as the user
    // can tell: Stop returns at once and drops its result
    const processOne = (file, index) => {
      const where = { fileName: file.name, index, total: files.length };
      setProgress({ ...where, stage: null, percent: null });
      const onProgress = ({ stage = null, percent = null, detail = null } = {}) => {
        // Not a late report of a processor that was stopped or has finished
        if (abortRef.current === controller && !signal.aborted) {
          setProgress({ ...where, stage, percent, ...(detail && { detail }) });
        }
      };
      return raceAbort(onProcessFile(file, { signal, onProgress }), signal);
    };

    try {
      setIsProcessing(true);

      if (allowMultiple) {
        // Process multiple files
        const results = [];
        for (const [index, file] of files.entries()) {
          let result;
          try {
            result = await processOne(file, index);
          } catch (err) {
            // Stopped: keep the files done so far
            if (isAbortError(err)) break;
            throw err;
          }
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

        // A stop keeps the files done so far, a discard (Clear, unmount) keeps none
        if (results.length > 0 && !isDiscarded()) {
          const newPreviews = results.map(r => r.preview || null);
          const newDataArray = results.map(r => r.data);

          // Merge with existing data if present
          const existingPreviews = Array.isArray(preview) ? preview : preview ? [preview] : [];
          const existingData = Array.isArray(fileData) ? fileData : fileData ? [fileData] : [];

          const mergedPreviews = [...existingPreviews, ...newPreviews];
          const mergedData = [...existingData, ...newDataArray];

          setPreview(mergedPreviews);
          setFileData(mergedData);
          if (onSelect) {
            onSelect(mergedData);
          }
        }
      } else {
        // Process single file (legacy behavior)
        const result = await processOne(files[0], 0);
        if (result && typeof result === 'object' && !isDiscarded()) {
          // Check if this is a multipage TIFF that returned multiple results
          if (result.multipleResults && Array.isArray(result.multipleResults)) {
            // For single file mode with multipage TIFF, use only the first page
            const firstResult = result.multipleResults[0];
            setPreview(firstResult.preview || null);
            setFileData(firstResult.data);
            if (onSelect) {
              onSelect(firstResult.data);
            }
          } else {
            setPreview(result.preview || null);
            setFileData(result.data);
            if (onSelect) {
              onSelect(result.data);
            }
          }
        }
      }
    } catch (err) {
      // Stopping is the user's doing, not an error to show
      if (!isAbortError(err)) {
        console.error('Error processing file:', err);
        setError(err.message || 'processing-error');
        setErrorParams(err.params || null);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsProcessing(false);
      setProgress(null);
      // So the same file can be picked again
      if (signal.aborted && fileInputRef.current) {
        fileInputRef.current.value = '';
      }
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

  const cancelProcessing = () => abortRef.current?.abort();

  const handleClear = () => {
    discardProcessing();
    setPreview(null);
    setFileData(null);
    setError(null);
    setErrorParams(null);
    setIsProcessing(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (onSelect) {
      onSelect(null);
    }
  };

  const handleRemoveItem = index => {
    if (Array.isArray(preview) && Array.isArray(fileData)) {
      const newPreview = preview.filter((_, i) => i !== index);
      const newData = fileData.filter((_, i) => i !== index);

      setPreview(newPreview.length > 0 ? newPreview : null);
      setFileData(newData.length > 0 ? newData : null);

      // Update the onSelect callback with filtered data
      if (onSelect) {
        onSelect(newData.length > 0 ? newData : null);
      }

      // Clear file input if no files left
      if (newPreview.length === 0 && fileInputRef.current) {
        fileInputRef.current.value = '';
      }
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
    errorParams,
    isProcessing,
    progress,
    cancelProcessing,
    isDragging,
    handleButtonClick,
    handleClear,
    handleRemoveItem,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    inputProps: {
      type: 'file',
      ref: fileInputRef,
      onChange: handleFileChange,
      accept: acceptAnyFile ? undefined : accept.join(','),
      disabled: disabled || isProcessing,
      className: 'hidden',
      multiple: allowMultiple
    }
  });
};

export default Uploader;
