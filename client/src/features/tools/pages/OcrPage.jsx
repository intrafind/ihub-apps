import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { apiClient } from '../../../api/client';

const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/webp'];
const ACCEPTED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'tiff', 'tif', 'webp'];

const OCR_MODES = [
  { value: 'full', label: 'Full VLM', description: 'Every page analyzed by AI (best quality)' },
  {
    value: 'smart',
    label: 'Smart',
    description: 'Auto-detect: skip AI for text-only pages (faster, cheaper)'
  },
  {
    value: 'text-only',
    label: 'Text Only',
    description: 'Extract embedded text only, no AI (fastest, free)'
  }
];

function isAcceptedFile(file) {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ACCEPTED_EXTENSIONS.includes(ext);
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

function StatusBadge({ status }) {
  const colors = {
    queued: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
    processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    building: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    error: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    cancelled: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
  };

  return (
    <span
      className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${colors[status] || colors.queued}`}
    >
      {status}
    </span>
  );
}

function JobCard({ job, onCancel }) {
  const eventSourceRef = useRef(null);
  const [progress, setProgress] = useState(job.progress || { current: 0, total: 0 });
  const [status, setStatus] = useState(job.status || 'queued');
  const [error, setError] = useState(job.error || null);

  useEffect(() => {
    if (status === 'completed' || status === 'error' || status === 'cancelled') return;

    const progressUrl = buildApiUrl(`/tools-service/jobs/${job.jobId}/progress`);
    const es = new EventSource(progressUrl, { withCredentials: true });
    eventSourceRef.current = es;

    es.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.progress) setProgress(data.progress);
      if (data.status) setStatus(data.status);
      if (data.error) setError(data.error);

      if (data.status === 'completed' || data.status === 'error' || data.status === 'cancelled') {
        es.close();
        eventSourceRef.current = null;
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [job.jobId, status]);

  const handleDownload = () => {
    const downloadUrl = buildApiUrl(`/tools-service/jobs/${job.jobId}/download`);
    window.open(downloadUrl, '_blank');
  };

  const isProcessing = ['queued', 'processing', 'building'].includes(status);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-900 dark:text-white truncate mr-2">
          {job.fileName}
        </span>
        <StatusBadge status={status} />
      </div>

      {isProcessing && progress.total > 0 && (
        <ProgressBar value={progress.current} max={progress.total} />
      )}

      {isProcessing && progress.total === 0 && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <div className="animate-spin rounded-full h-3 w-3 border-2 border-blue-600 border-t-transparent" />
          Analyzing PDF...
        </div>
      )}

      {status === 'error' && error && (
        <div className="text-sm text-red-600 dark:text-red-400 mt-1">{error}</div>
      )}

      <div className="flex gap-2 mt-2">
        {status === 'completed' && (
          <button
            onClick={handleDownload}
            className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition-colors font-medium"
          >
            Download
          </button>
        )}
        {isProcessing && (
          <button
            onClick={() => onCancel(job.jobId)}
            className="px-3 py-1 text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors font-medium"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export default function OcrPage() {
  const [files, setFiles] = useState([]);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [ocrMode, setOcrMode] = useState('full');
  const [debugMode, setDebugMode] = useState(false);
  const [status, setStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [activeJobs, setActiveJobs] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

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

  const handleFileSelect = useCallback(selectedFiles => {
    const fileList = Array.isArray(selectedFiles) ? selectedFiles : [selectedFiles];
    const accepted = fileList.filter(f => f && isAcceptedFile(f));
    if (accepted.length === 0) return;

    setFiles(accepted);
    setStatus('idle');
    setErrorMessage('');
    setActiveJobs([]);
  }, []);

  const handleDrop = useCallback(
    e => {
      e.preventDefault();
      setDragOver(false);
      handleFileSelect(Array.from(e.dataTransfer.files));
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
    setErrorMessage('');
    setStatus('uploading');

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }
      if (selectedModel) formData.append('modelId', selectedModel);
      if (customPrompt.trim()) formData.append('prompt', customPrompt.trim());
      formData.append('ocrMode', ocrMode);
      if (debugMode) formData.append('debugMode', 'true');

      const response = await apiClient.post('/tools-service/ocr/process', formData, {
        timeout: 0,
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      const { jobs } = response.data;
      setActiveJobs(jobs);
      setStatus('processing');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err.response?.data?.error || err.message || 'Failed to start OCR');
    }
  };

  const handleCancel = async jobId => {
    try {
      await apiClient.patch(`/tools-service/jobs/${jobId}/cancel`);
    } catch {
      // Job may already be done
    }
  };

  const handleReset = () => {
    setFiles([]);
    setStatus('idle');
    setErrorMessage('');
    setActiveJobs([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const isProcessing = ['uploading', 'processing'].includes(status);
  const fileLabel =
    files.length === 1
      ? files[0].name
      : `${files.length} file${files.length !== 1 ? 's' : ''} selected`;
  const fileSize = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">AI OCR</h1>
        <Link to="/tools/jobs" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
          View all jobs
        </Link>
      </div>
      <p className="text-gray-600 dark:text-gray-400 mb-6">
        Upload scanned PDFs or images to extract text using AI vision. The text is embedded as a
        searchable layer in the resulting PDF.
      </p>

      {/* Model selector */}
      {models.length > 0 && ocrMode !== 'text-only' && (
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

      {/* OCR Mode selector */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          OCR Mode
        </label>
        <div className="flex gap-2">
          {OCR_MODES.map(mode => (
            <button
              key={mode.value}
              type="button"
              onClick={() => setOcrMode(mode.value)}
              disabled={isProcessing}
              className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors disabled:opacity-50 ${
                ocrMode === mode.value
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-medium'
                  : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-blue-300'
              }`}
              title={mode.description}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {OCR_MODES.find(m => m.value === ocrMode)?.description}
        </p>
      </div>

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
          <div className="mt-2 space-y-3">
            {ocrMode !== 'text-only' && (
              <div>
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
        )}
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
              PDF, JPEG, PNG, TIFF, or WebP — multiple files supported
            </p>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="mt-4 flex gap-3">
        {status === 'idle' && files.length > 0 && (
          <button
            onClick={startOcr}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium text-sm"
          >
            Start OCR
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

      {/* Error */}
      {status === 'error' && errorMessage && (
        <div className="mt-4 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
          {errorMessage}
        </div>
      )}

      {/* Active jobs */}
      {activeJobs.length > 0 && (
        <div className="mt-6 space-y-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Jobs ({activeJobs.length})
          </h2>
          {activeJobs.map(job => (
            <JobCard key={job.jobId} job={job} onCancel={handleCancel} />
          ))}
        </div>
      )}
    </div>
  );
}
