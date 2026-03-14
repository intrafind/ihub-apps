import React, { useState, useEffect, useRef, useCallback } from 'react';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { apiClient } from '../../../api/client';

const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/webp'];

const ACCEPTED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'tiff', 'tif', 'webp'];

const STATUS_LABELS = {
  idle: 'Ready',
  rendering: 'Rendering PDF pages...',
  preparing: 'Preparing images...',
  uploading: 'Starting OCR processing...',
  processing: 'Extracting text with AI...',
  building: 'Building PDF with text layer...',
  completed: 'OCR complete!',
  error: 'An error occurred'
};

/**
 * Render a single PDF page to a base64 JPEG image using pdfjs-dist.
 * Uses adaptive scaling: target ~1600px on the long edge for good OCR
 * quality while keeping file sizes manageable for large documents.
 */
async function renderPageToImage(pdfDoc, pageNum, scale = 2) {
  const page = await pdfDoc.getPage(pageNum);
  const defaultViewport = page.getViewport({ scale: 1 });
  const longEdge = Math.max(defaultViewport.width, defaultViewport.height);

  // Target ~1600px on the long edge; cap at the requested scale
  const TARGET_LONG_EDGE = 1600;
  const adaptiveScale = Math.min(scale, TARGET_LONG_EDGE / longEdge);
  const viewport = page.getViewport({ scale: adaptiveScale });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  // JPEG at 0.85 quality is ~5-10x smaller than PNG for document pages
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return dataUrl.split(',')[1];
}

/**
 * Load pdfjs-dist and render all pages to images
 */
async function renderPdfToImages(file, onProgress) {
  const pdfjsLib = await import('pdfjs-dist');

  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;
  const images = [];

  for (let i = 1; i <= numPages; i++) {
    onProgress(i, numPages);
    const base64 = await renderPageToImage(pdf, i);
    images.push(base64);
  }

  return { images, numPages };
}

/**
 * Read an image file as base64 (without the data URL prefix).
 * Converts TIFF/WebP to PNG via canvas for pdf-lib compatibility.
 */
async function readImageAsBase64(file) {
  const needsConversion = file.type === 'image/tiff' || file.type === 'image/webp';

  if (needsConversion) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const dataUrl = canvas.toDataURL('image/png');
        resolve(dataUrl.split(',')[1]);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Failed to load image: ${file.name}`));
      };
      img.src = url;
    });
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      resolve(dataUrl.split(',')[1]);
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Check if a file is an accepted type by MIME or extension fallback.
 */
function isAcceptedFile(file) {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ACCEPTED_EXTENSIONS.includes(ext);
}

function isPdfFile(file) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function ProgressBar({ value, max, label }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full">
      {label && <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">{label}</div>}
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
        <div
          className="bg-blue-600 h-3 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 text-right">
        {value} / {max} ({pct}%)
      </div>
    </div>
  );
}

export default function PdfOcrPage() {
  const [files, setFiles] = useState([]);
  const [inputType, setInputType] = useState(null); // 'pdf' or 'images'
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoDownload, setAutoDownload] = useState(true);
  const [debugMode, setDebugMode] = useState(false);
  const [status, setStatus] = useState('idle');
  const [renderProgress, setRenderProgress] = useState({ current: 0, total: 0 });
  const [ocrProgress, setOcrProgress] = useState({ current: 0, total: 0 });
  const [errorMessage, setErrorMessage] = useState('');
  const [jobId, setJobId] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const eventSourceRef = useRef(null);

  // Fetch available models on mount
  useEffect(() => {
    apiClient
      .get('/tools-service/ocr/models')
      .then(res => {
        const data = res.data;
        setModels(data);
        const defaultModel =
          data.find(m => m.supportsVision) || data.find(m => m.isDefault) || data[0];
        if (defaultModel) setSelectedModel(defaultModel.id);
      })
      .catch(() => {
        // Silently fail - models dropdown will just be empty
      });
  }, []);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  const handleFileSelect = useCallback(selectedFiles => {
    const fileList = Array.isArray(selectedFiles) ? selectedFiles : [selectedFiles];
    const accepted = fileList.filter(f => f && isAcceptedFile(f));
    if (accepted.length === 0) return;

    // If first file is PDF, use PDF mode (single file only)
    if (isPdfFile(accepted[0])) {
      setFiles([accepted[0]]);
      setInputType('pdf');
    } else {
      // Image mode — accept all image files
      const imageFiles = accepted.filter(f => !isPdfFile(f));
      setFiles(imageFiles);
      setInputType('images');
    }

    setStatus('idle');
    setErrorMessage('');
    setJobId(null);
    setOcrProgress({ current: 0, total: 0 });
    setRenderProgress({ current: 0, total: 0 });
  }, []);

  const handleDrop = useCallback(
    e => {
      e.preventDefault();
      setDragOver(false);
      const droppedFiles = Array.from(e.dataTransfer.files);
      handleFileSelect(droppedFiles);
    },
    [handleFileSelect]
  );

  const handleDragOver = useCallback(e => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(e => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const startOcr = async () => {
    if (files.length === 0) return;
    cleanup();
    setErrorMessage('');

    try {
      let requestBody;

      if (inputType === 'pdf') {
        setStatus('rendering');
        const pdfFile = files[0];

        // Render PDF pages to images on the client
        const { images, numPages } = await renderPdfToImages(pdfFile, (current, total) => {
          setRenderProgress({ current, total });
        });

        // Get the original PDF as base64
        const arrayBuffer = await pdfFile.arrayBuffer();
        const originalPdfBase64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );

        requestBody = {
          inputType: 'pdf',
          pageImages: images,
          originalPdf: originalPdfBase64,
          modelId: selectedModel || undefined,
          prompt: customPrompt.trim() || undefined,
          fileName: pdfFile.name,
          debugMode: debugMode || undefined
        };

        setOcrProgress({ current: 0, total: numPages });
      } else {
        // Image mode
        setStatus('preparing');
        const imageBase64s = [];
        for (let i = 0; i < files.length; i++) {
          setRenderProgress({ current: i + 1, total: files.length });
          const base64 = await readImageAsBase64(files[i]);
          imageBase64s.push(base64);
        }

        // Use first image's name with .pdf extension, or fallback
        const firstFileName = files[0]?.name || 'ocr-result.png';
        const baseName = firstFileName.replace(/\.[^.]+$/, '');
        const outputName =
          files.length === 1 ? `${baseName}.pdf` : `${baseName}-and-${files.length - 1}-more.pdf`;

        requestBody = {
          inputType: 'images',
          images: imageBase64s,
          modelId: selectedModel || undefined,
          prompt: customPrompt.trim() || undefined,
          fileName: outputName,
          debugMode: debugMode || undefined
        };

        setOcrProgress({ current: 0, total: files.length });
      }

      setStatus('uploading');

      // Send to server
      const response = await apiClient.post('/tools-service/ocr/process', requestBody, {
        timeout: 0
      });

      const { jobId: newJobId, totalPages } = response.data;
      setJobId(newJobId);
      setOcrProgress(prev => ({ ...prev, total: totalPages }));

      // Connect to SSE for progress
      const progressUrl = buildApiUrl(`/tools-service/jobs/${newJobId}/progress`);
      const es = new EventSource(progressUrl, { withCredentials: true });
      eventSourceRef.current = es;

      es.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.progress) {
          setOcrProgress({ current: data.progress.current, total: data.progress.total });
        }

        if (data.status === 'processing' || data.status === 'building') {
          setStatus(data.status);
        } else if (data.status === 'completed') {
          setStatus('completed');
          es.close();
          eventSourceRef.current = null;
          if (autoDownload) {
            const downloadUrl = buildApiUrl(`/tools-service/jobs/${newJobId}/download`);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = '';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
        } else if (data.status === 'error') {
          setStatus('error');
          setErrorMessage(data.error || 'Unknown error during OCR processing');
          es.close();
          eventSourceRef.current = null;
        }
      };

      es.onerror = () => {
        if (status !== 'completed') {
          setStatus('error');
          setErrorMessage('Lost connection to server. The job may still be processing.');
        }
        es.close();
        eventSourceRef.current = null;
      };
    } catch (err) {
      setStatus('error');
      setErrorMessage(err.response?.data?.error || err.message || 'Failed to start OCR');
    }
  };

  const handleDownload = () => {
    if (!jobId) return;
    const downloadUrl = buildApiUrl(`/tools-service/jobs/${jobId}/download`);
    window.open(downloadUrl, '_blank');
  };

  const handleReset = () => {
    cleanup();
    setFiles([]);
    setInputType(null);
    setStatus('idle');
    setErrorMessage('');
    setJobId(null);
    setOcrProgress({ current: 0, total: 0 });
    setRenderProgress({ current: 0, total: 0 });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const isProcessing = ['rendering', 'preparing', 'uploading', 'processing', 'building'].includes(
    status
  );

  const fileLabel =
    files.length === 1
      ? files[0].name
      : `${files.length} image${files.length !== 1 ? 's' : ''} selected`;
  const fileSize = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">PDF OCR</h1>
      <p className="text-gray-600 dark:text-gray-400 mb-6">
        Upload a scanned PDF or images to extract text using AI vision. The text is embedded as a
        searchable layer in the resulting PDF.
      </p>

      {/* Model selector */}
      {models.length > 0 && (
        <div className="mb-4">
          <label
            htmlFor="model-select"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            AI Model
          </label>
          <select
            id="model-select"
            value={selectedModel}
            onChange={e => setSelectedModel(e.target.value)}
            disabled={isProcessing}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>
                {typeof m.name === 'object' ? m.name.en || m.name[Object.keys(m.name)[0]] : m.name}
                {m.supportsVision ? ' (Vision)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Advanced options */}
      <div className="mb-4">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          disabled={isProcessing}
          className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors disabled:opacity-50"
        >
          <svg
            className={`h-4 w-4 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          Advanced Options
        </button>
        {showAdvanced && (
          <div className="mt-2">
            <label
              htmlFor="custom-prompt"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Custom OCR Prompt
            </label>
            <textarea
              id="custom-prompt"
              value={customPrompt}
              onChange={e => setCustomPrompt(e.target.value)}
              disabled={isProcessing}
              rows={4}
              maxLength={2000}
              placeholder="Leave empty to use the default prompt (handles tables, charts, diagrams, and mixed content)..."
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 resize-y"
            />
            <div className="text-xs text-gray-400 dark:text-gray-500 mt-1 text-right">
              {customPrompt.length} / 2000
            </div>
          </div>
        )}
      </div>

      {/* Options */}
      <div className="mb-4 flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={autoDownload}
            onChange={e => setAutoDownload(e.target.checked)}
            disabled={isProcessing}
            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
          />
          Auto-download on completion
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={debugMode}
            onChange={e => setDebugMode(e.target.checked)}
            disabled={isProcessing}
            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
          />
          Debug mode — add visible text pages
        </label>
      </div>

      {/* File upload area */}
      <div
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${
          dragOver
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
            : files.length > 0
              ? 'border-green-400 bg-green-50 dark:bg-green-900/20'
              : 'border-gray-300 dark:border-gray-600 hover:border-blue-400 dark:hover:border-blue-500'
        } ${isProcessing ? 'pointer-events-none opacity-60' : ''}`}
        onClick={() => !isProcessing && fileInputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.tiff,.tif,.webp"
          multiple
          className="hidden"
          onChange={e => handleFileSelect(Array.from(e.target.files))}
        />

        {files.length > 0 ? (
          <div>
            <svg
              className="mx-auto h-10 w-10 text-green-500 mb-2"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="font-medium text-gray-900 dark:text-white">{fileLabel}</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {(fileSize / 1024 / 1024).toFixed(2)} MB
              {inputType === 'images' &&
                ` \u2022 ${files.length} image${files.length !== 1 ? 's' : ''}`}
            </p>
          </div>
        ) : (
          <div>
            <svg
              className="mx-auto h-10 w-10 text-gray-400 mb-2"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
              />
            </svg>
            <p className="text-gray-600 dark:text-gray-400">
              Drop files here or <span className="text-blue-600 dark:text-blue-400">browse</span>
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              PDF, JPEG, PNG, TIFF, or WebP
            </p>
          </div>
        )}
      </div>

      {/* Progress section */}
      {status !== 'idle' && (
        <div className="mt-6 space-y-4">
          <div className="flex items-center gap-2">
            {isProcessing && (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-600 border-t-transparent" />
            )}
            <span
              className={`text-sm font-medium ${
                status === 'completed'
                  ? 'text-green-600 dark:text-green-400'
                  : status === 'error'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-blue-600 dark:text-blue-400'
              }`}
            >
              {STATUS_LABELS[status] || status}
            </span>
          </div>

          {(status === 'rendering' || status === 'preparing') && renderProgress.total > 0 && (
            <ProgressBar
              value={renderProgress.current}
              max={renderProgress.total}
              label={status === 'rendering' ? 'Rendering pages...' : 'Preparing images...'}
            />
          )}

          {['uploading', 'processing', 'building', 'completed'].includes(status) &&
            ocrProgress.total > 0 && (
              <ProgressBar
                value={ocrProgress.current}
                max={ocrProgress.total}
                label="OCR progress"
              />
            )}

          {status === 'error' && errorMessage && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
              {errorMessage}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-6 flex gap-3">
        {status === 'idle' && files.length > 0 && (
          <button
            onClick={startOcr}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium text-sm"
          >
            Start OCR
          </button>
        )}

        {status === 'completed' && (
          <button
            onClick={handleDownload}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium text-sm"
          >
            Download PDF
          </button>
        )}

        {(files.length > 0 || status !== 'idle') && !isProcessing && (
          <button
            onClick={handleReset}
            className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors font-medium text-sm"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
