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
    }
  }, [source?.config?.path, isEditing, loadCurrentFile]);

  const handleFileUpload = async event => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      setLoading(true);
      setError(null);

      // Read file content
      const content = await readFileContent(file);

      // Generate file path in sources directory
      const fileName = `${source.id}_${Date.now()}_${file.name}`;
      const filePath = `sources/${fileName}`;

      // Upload file
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
            path: filePath,
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
      } else {
        setError(response.data.error || 'Failed to upload file');
      }
    } catch (err) {
      console.error('Failed to upload file:', err);
      setError(err.message || 'Failed to upload file');
    } finally {
      setLoading(false);
    }
  };

  const readFileContent = file => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  };

  const saveFileContent = async () => {
    if (!currentFile?.path) return;

    try {
      setLoading(true);
      setError(null);

      const response = await makeAdminApiCall(`/admin/sources/${source.id}/files`, {
        method: 'POST',
        body: JSON.stringify({
          path: currentFile.path,
          content: fileContent,
          encoding: 'utf8'
        })
      });

      if (response.data.success) {
        setHasUnsavedChanges(false);
        setIsEditingContent(false);

        // Update file metadata
        setCurrentFile(prev => ({
          ...prev,
          size: new TextEncoder().encode(fileContent).length,
          modified: new Date().toISOString()
        }));
      } else {
        setError(response.data.error || 'Failed to save file');
      }
    } catch (err) {
      console.error('Failed to save file:', err);
      setError(err.message || 'Failed to save file');
    } finally {
      setLoading(false);
    }
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
              {isEditing && (
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
              )}
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
                  readOnly: !isEditing
                }}
                theme="vs-light"
              />
            </Suspense>
          </div>
        )}

        {/* File Upload Input - Hide when editing content */}
        {!isEditingContent && (
          <div className="relative">
            <input
              type="file"
              onChange={handleFileUpload}
              disabled={loading || !isEditing}
              className="sr-only"
              id="file-upload"
              accept=".txt,.md,.json,.xml,.csv,.log,.conf,.yaml,.yml"
            />
            <label
              htmlFor="file-upload"
              className={`flex items-center justify-center px-4 py-2 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                loading || !isEditing
                  ? 'border-gray-300 bg-gray-50 cursor-not-allowed'
                  : 'border-gray-300 hover:border-gray-400 bg-white'
              }`}
            >
              <div className="space-y-1 text-center">
                <Icon
                  name={loading ? 'arrow-path' : 'cloud-arrow-up'}
                  className={`mx-auto h-8 w-8 ${loading ? 'animate-spin text-gray-400' : 'text-gray-400'}`}
                />
                <div className="flex text-sm text-gray-600">
                  <span className="font-medium text-blue-600 hover:text-blue-500">
                    {currentFile
                      ? t('admin.sources.uploadNewFile', 'Upload new file')
                      : t('admin.sources.uploadFile', 'Upload file')}
                  </span>
                  <p className="pl-1">{t('admin.sources.orDragDrop', 'or drag and drop')}</p>
                </div>
                <p className="text-xs text-gray-500">
                  {t(
                    'admin.sources.supportedFormats',
                    'TXT, MD, JSON, XML, CSV, LOG, CONF, YAML up to 10MB'
                  )}
                </p>
              </div>
            </label>
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
              'Upload a file to use as the content source. The file will be stored securely and referenced by this source.'
            )}
          </p>
        )}
      </div>
    </div>
  );
};

export default FileUploader;
