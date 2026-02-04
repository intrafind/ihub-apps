import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall } from '../../../api/adminApi';
import Icon from '../../../shared/components/Icon';

const MonacoEditor = lazy(() => import('@monaco-editor/react'));

const FileUploader = ({ source, onChange, isEditing }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentFile, setCurrentFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [isEditingContent, setIsEditingContent] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const loadCurrentFile = useCallback(async () => {
    if (!source?.id || !source?.config?.path) return;

    try {
      setLoading(true);
      setError(null);

      const response = await makeAdminApiCall(
        `/admin/sources/${source.id}/files/content?path=${encodeURIComponent(source.config.path)}`
      );

      if (response.data.success) {
        setCurrentFile({
          name: source.config.path.split('/').pop(),
          path: source.config.path,
          size: response.data.metadata?.size,
          modified: response.data.metadata?.modified
        });
        // Store full content for editing
        setFileContent(response.data.content);
      }
    } catch (err) {
      console.error('Failed to load current file:', err);
      // File might not exist yet, which is okay
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    // Load current file info if source has a file path configured
    if (source?.config?.path && isEditing) {
      loadCurrentFile();
    } else if (source?.config?.tempContent) {
      // Load temporary content for new sources
      setCurrentFile({
        name: source.config.originalFileName || 'content.txt',
        path: source.config.path || '',
        size: new TextEncoder().encode(source.config.tempContent).length,
        modified: source.config.uploadedAt || new Date().toISOString()
      });
      setFileContent(source.config.tempContent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.config?.path, source?.config?.tempContent, isEditing, loadCurrentFile]);

  const processFile = async file => {
    if (!file) return;

    // Check file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
      setError(t('admin.sources.fileTooLarge', 'File size exceeds 10MB limit'));
      return;
    }

    // Check file type
    const allowedExtensions = [
      '.txt',
      '.md',
      '.json',
      '.xml',
      '.csv',
      '.log',
      '.conf',
      '.yaml',
      '.yml'
    ];
    const fileExtension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (!allowedExtensions.includes(fileExtension)) {
      setError(t('admin.sources.unsupportedFileType', 'Unsupported file type'));
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Read file content
      const content = await readFileContent(file);

      // Generate file path using source ID to avoid conflicts
      const sourceId = source.id || `temp_${Date.now()}`;
      const timestamp = Date.now();
      const fileExtension = file.name.substring(file.name.lastIndexOf('.'));
      const fileName = `${sourceId}_${timestamp}${fileExtension}`;
      const filePath = `sources/${fileName}`;

      if (source.id && isEditing) {
        // Source already exists on server, upload to server
        const response = await makeAdminApiCall(`/admin/sources/${source.id}/files`, {
          method: 'POST',
          body: JSON.stringify({
            path: filePath,
            content: content,
            encoding: 'utf8'
          })
        });

        if (response.data.success) {
          // Update source configuration with new file path
          const updatedSource = {
            ...source,
            config: {
              ...source.config,
              path: filePath
            }
          };

          onChange(updatedSource);

          setCurrentFile({
            name: file.name,
            path: filePath,
            size: file.size,
            modified: new Date().toISOString()
          });
          setFileContent(content);
          setHasUnsavedChanges(false);
        } else {
          setError(response.data.error || 'Failed to upload file');
        }
      } else {
        // New source, store content temporarily until source is saved
        const updatedSource = {
          ...source,
          config: {
            ...source.config,
            path: filePath,
            tempContent: content,
            originalFileName: file.name,
            uploadedAt: new Date().toISOString()
          }
        };

        onChange(updatedSource);

        setCurrentFile({
          name: file.name,
          path: filePath,
          size: file.size,
          modified: new Date().toISOString()
        });
        setFileContent(content);
        setHasUnsavedChanges(false);
      }
    } catch (err) {
      console.error('Failed to upload file:', err);
      setError(err.message || 'Failed to upload file');
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async event => {
    const file = event.target.files[0];
    await processFile(file);
  };

  const readFileContent = file => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  };

  const handleDragEnter = e => {
    e.preventDefault();
    e.stopPropagation();
    if (!loading) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = e => {
    e.preventDefault();
    e.stopPropagation();
    // Only set dragging to false if we're leaving the drop zone entirely
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  };

  const handleDragOver = e => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async e => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (loading) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await processFile(files[0]);
    }
  };

  const saveFileContent = async () => {
    if (!currentFile?.path && !fileContent.trim()) return;

    try {
      setLoading(true);
      setError(null);

      let filePath = currentFile?.path;

      // If no file path exists yet, create a new one
      if (!filePath) {
        const sourceId = source.id || `temp_${Date.now()}`;
        const timestamp = Date.now();
        const fileName = `${sourceId}_${timestamp}.txt`;
        filePath = `sources/${fileName}`;
      }

      if (source.id && isEditing) {
        // Source exists on server, save to server
        const response = await makeAdminApiCall(`/admin/sources/${source.id}/files`, {
          method: 'POST',
          body: JSON.stringify({
            path: filePath,
            content: fileContent,
            encoding: 'utf8'
          })
        });

        if (response.data.success) {
          setHasUnsavedChanges(false);
          setIsEditingContent(false);

          // Always update source configuration with the current path
          const updatedSource = {
            ...source,
            config: {
              ...source.config,
              path: filePath
            }
          };
          onChange(updatedSource);

          // Update file metadata
          setCurrentFile({
            name: currentFile?.name || 'content.txt',
            path: filePath,
            size: new TextEncoder().encode(fileContent).length,
            modified: new Date().toISOString()
          });
        } else {
          setError(response.data.error || 'Failed to save file');
        }
      } else {
        // New source, store content temporarily
        setHasUnsavedChanges(false);
        setIsEditingContent(false);

        const updatedSource = {
          ...source,
          config: {
            ...source.config,
            path: filePath,
            tempContent: fileContent,
            originalFileName: currentFile?.name || 'content.txt',
            uploadedAt: new Date().toISOString()
          }
        };
        onChange(updatedSource);

        setCurrentFile({
          name: currentFile?.name || 'content.txt',
          path: filePath,
          size: new TextEncoder().encode(fileContent).length,
          modified: new Date().toISOString()
        });
      }
    } catch (err) {
      console.error('Failed to save file:', err);
      setError(err.message || 'Failed to save file');
    } finally {
      setLoading(false);
    }
  };

  const createNewContent = () => {
    const sourceId = source.id || `temp_${Date.now()}`;
    const timestamp = Date.now();
    const fileName = `${sourceId}_${timestamp}.txt`;
    const filePath = `sources/${fileName}`;

    setCurrentFile({
      name: 'content.txt',
      path: filePath,
      size: 0,
      modified: new Date().toISOString()
    });
    setFileContent('');
    setIsEditingContent(true);
    setHasUnsavedChanges(false);

    // Update source config to include the path and temp content
    const updatedSource = {
      ...source,
      config: {
        ...source.config,
        path: filePath,
        tempContent: '',
        originalFileName: 'content.txt',
        uploadedAt: new Date().toISOString()
      }
    };
    onChange(updatedSource);
  };

  const formatFileSize = bytes => {
    if (!bytes) return 'Unknown size';
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const getLanguageFromFileName = fileName => {
    if (!fileName) return 'plaintext';

    const ext = fileName.split('.').pop()?.toLowerCase();
    const languageMap = {
      js: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      json: 'json',
      md: 'markdown',
      yml: 'yaml',
      yaml: 'yaml',
      xml: 'xml',
      html: 'html',
      css: 'css',
      py: 'python',
      sh: 'shell',
      bash: 'shell',
      sql: 'sql',
      txt: 'plaintext',
      log: 'plaintext',
      conf: 'ini',
      ini: 'ini',
      csv: 'plaintext'
    };

    return languageMap[ext] || 'plaintext';
  };

  if (source?.type !== 'filesystem') {
    return null;
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t('admin.sources.sourceFile', 'Source File')}
        </label>

        {/* Current File Display */}
        {currentFile && (
          <div className="bg-gray-50 rounded-lg p-4 mb-4">
            <div className="flex items-start justify-between">
              <div className="flex items-start">
                <Icon name="document-text" className="h-5 w-5 text-gray-400 mr-3 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-gray-900">{currentFile.name}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {formatFileSize(currentFile.size)} •
                    {currentFile.modified &&
                      ` ${new Date(currentFile.modified).toLocaleDateString()}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {!isEditingContent ? (
                  <button
                    type="button"
                    onClick={() => setIsEditingContent(true)}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    {t('admin.sources.editContent', 'Edit Content')}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={saveFileContent}
                      disabled={loading || !hasUnsavedChanges}
                      className="text-sm text-green-600 hover:text-green-700 font-medium disabled:opacity-50"
                    >
                      {t('common.save', 'Save')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingContent(false);
                        setHasUnsavedChanges(false);
                        // Reload original content
                        loadCurrentFile();
                      }}
                      className="text-sm text-gray-600 hover:text-gray-700 font-medium"
                    >
                      {t('common.cancel', 'Cancel')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Monaco Editor for editing content */}
        {isEditingContent && currentFile && (
          <div className="mt-4 border rounded-lg overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 border-b flex items-center justify-between">
              <p className="text-sm font-medium text-gray-700">
                {t('admin.sources.editingFile', 'Editing: {{file}}', { file: currentFile.name })}
              </p>
              {hasUnsavedChanges && (
                <span className="text-xs text-orange-600 font-medium">
                  {t('admin.sources.unsavedChanges', 'Unsaved changes')}
                </span>
              )}
            </div>
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-96 bg-gray-50">
                  <Icon name="arrow-path" className="animate-spin h-6 w-6 text-gray-400" />
                </div>
              }
            >
              <MonacoEditor
                height="400px"
                language={getLanguageFromFileName(currentFile.name)}
                value={fileContent}
                onChange={value => {
                  setFileContent(value || '');
                  setHasUnsavedChanges(true);
                }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 14,
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  readOnly: false
                }}
                theme="vs-light"
              />
            </Suspense>
          </div>
        )}

        {/* File Upload Input and Create Content Options - Hide when editing content */}
        {!isEditingContent && (
          <div className="space-y-4">
            {/* Upload File Section */}
            <div
              className="relative"
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              <input
                type="file"
                onChange={handleFileUpload}
                disabled={loading}
                className="sr-only"
                id="file-upload"
                accept=".txt,.md,.json,.xml,.csv,.log,.conf,.yaml,.yml"
              />
              <label
                htmlFor="file-upload"
                className={`flex items-center justify-center px-4 py-2 border-2 border-dashed rounded-lg transition-all ${
                  loading
                    ? 'border-gray-300 bg-gray-50 cursor-not-allowed'
                    : isDragging
                      ? 'border-blue-400 bg-blue-50 cursor-copy'
                      : 'border-gray-300 hover:border-gray-400 bg-white cursor-pointer'
                }`}
              >
                <div className="space-y-1 text-center pointer-events-none">
                  <Icon
                    name={
                      loading ? 'arrow-path' : isDragging ? 'document-arrow-down' : 'cloud-arrow-up'
                    }
                    className={`mx-auto h-8 w-8 ${
                      loading
                        ? 'animate-spin text-gray-400'
                        : isDragging
                          ? 'text-blue-500'
                          : 'text-gray-400'
                    }`}
                  />
                  <div className="flex text-sm text-gray-600">
                    {isDragging ? (
                      <span className="font-medium text-blue-600">
                        {t('admin.sources.dropFileHere', 'Drop file here')}
                      </span>
                    ) : (
                      <>
                        <span className="font-medium text-blue-600 hover:text-blue-500">
                          {currentFile
                            ? t('admin.sources.uploadNewFile', 'Upload new file')
                            : t('admin.sources.uploadFile', 'Upload file')}
                        </span>
                        <p className="pl-1">{t('admin.sources.orDragDrop', 'or drag and drop')}</p>
                      </>
                    )}
                  </div>
                  {!isDragging && (
                    <p className="text-xs text-gray-500">
                      {t(
                        'admin.sources.supportedFormats',
                        'TXT, MD, JSON, XML, CSV, LOG, CONF, YAML up to 10MB'
                      )}
                    </p>
                  )}
                </div>
              </label>
            </div>

            {/* Create New Content Option */}
            {!currentFile && (
              <div className="text-center">
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-300" />
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 bg-white text-gray-500">
                      {t('admin.sources.or', 'or')}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={createNewContent}
                  disabled={loading}
                  className="mt-4 inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Icon name="document-plus" className="h-4 w-4 mr-2" />
                  {t('admin.sources.createNewContent', 'Create new content')}
                </button>
                <p className="mt-2 text-xs text-gray-500">
                  {t(
                    'admin.sources.createNewContentHelp',
                    'Start writing content directly in the editor'
                  )}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mt-2 bg-red-50 border border-red-200 rounded-lg p-3">
            <div className="flex items-center">
              <Icon name="x-circle" className="h-4 w-4 text-red-400 mr-2" />
              <p className="text-sm text-red-800">{error}</p>
              <button
                onClick={() => setError(null)}
                className="ml-auto text-red-600 hover:text-red-800"
              >
                <Icon name="x-mark" className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}

        {/* Help Text */}
        {!currentFile && !error && (
          <p className="mt-2 text-xs text-gray-500">
            {t(
              'admin.sources.fileUploadHelp',
              'Upload a file or create new content to use as the content source. The file will be stored securely and referenced by this source.'
            )}
          </p>
        )}
      </div>
    </div>
  );
};

export default FileUploader;
