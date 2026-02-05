import { useState, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';

/**
 * MonacoJsonEditor - A professional JSON editor wrapper around Monaco Editor
 *
 * @component
 * @param {Object} props - Component props
 * @param {Object} props.value - The JSON object to edit
 * @param {Function} props.onChange - Callback fired when JSON changes (receives parsed object)
 * @param {Function} props.onValidationChange - Callback fired when validation state changes
 * @param {Object} props.schema - JSON schema for validation (optional)
 * @param {boolean} props.readOnly - Whether the editor is read-only
 * @param {string} props.height - Editor height (default: '400px')
 * @param {string} props.theme - Editor theme ('vs-dark' | 'light' | 'vs')
 * @param {boolean} props.showMinimap - Whether to show minimap (default: false)
 * @param {boolean} props.wordWrap - Whether to enable word wrap (default: true)
 * @param {Function} props.onMount - Callback fired when editor mounts
 * @param {string} props.className - Additional CSS classes
 * @returns {React.Component} MonacoJsonEditor component
 */
const MonacoJsonEditor = ({
  value = {},
  onChange,
  onValidationChange,
  schema,
  readOnly = false,
  height = '400px',
  theme = 'vs',
  showMinimap = false,
  wordWrap = true,
  onMount,
  className = ''
}) => {
  const { t } = useTranslation();
  const editorRef = useRef();
  const monacoRef = useRef();
  const [jsonString, setJsonString] = useState('');
  const [validationErrors, setValidationErrors] = useState([]);
  const [isValidJson, setIsValidJson] = useState(true);
  const isInternalChange = useRef(false);
  const lastExternalValue = useRef(null);

  // Convert object to formatted JSON string - only when value changes externally
  useEffect(() => {
    // Skip if this is our own internal change
    if (isInternalChange.current) {
      isInternalChange.current = false;
      return;
    }

    // Check if value actually changed from external source
    const valueStr = JSON.stringify(value);
    if (valueStr === lastExternalValue.current) {
      return;
    }
    lastExternalValue.current = valueStr;

    try {
      const formatted = JSON.stringify(value, null, 2);
      setJsonString(formatted);
    } catch (error) {
      console.error('Error formatting JSON:', error);
      setJsonString('{}');
    }
  }, [value]);

  /**
   * Handle editor mount - configure JSON language features
   */
  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Configure JSON language options
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      schemas: schema
        ? [
            {
              uri: 'http://myschema.json',
              fileMatch: ['*'],
              schema: schema
            }
          ]
        : [],
      enableSchemaRequest: false
    });

    // Set up validation markers
    const updateMarkers = () => {
      const model = editor.getModel();
      if (model) {
        const markers = monaco.editor.getModelMarkers({ resource: model.uri });
        const errors = markers.map(marker => ({
          line: marker.startLineNumber,
          column: marker.startColumn,
          message: marker.message,
          severity: marker.severity
        }));

        setValidationErrors(errors);
        const hasErrors = errors.some(error => error.severity === monaco.MarkerSeverity.Error);
        setIsValidJson(!hasErrors);

        if (onValidationChange) {
          onValidationChange({
            isValid: !hasErrors,
            errors: errors
          });
        }
      }
    };

    // Listen for marker changes
    monaco.editor.onDidChangeMarkers(updateMarkers);

    // Initial validation
    setTimeout(updateMarkers, 100);

    // Call external onMount callback
    if (onMount) {
      onMount(editor, monaco);
    }
  };

  /**
   * Handle content changes in the editor
   */
  const handleEditorChange = newValue => {
    setJsonString(newValue || '');

    // Attempt to parse and validate JSON
    try {
      const parsed = JSON.parse(newValue || '{}');
      setIsValidJson(true);

      if (onChange) {
        // Mark this as an internal change to prevent useEffect from resetting
        isInternalChange.current = true;
        lastExternalValue.current = JSON.stringify(parsed);
        onChange(parsed);
      }
    } catch {
      setIsValidJson(false);
      // Don't call onChange for invalid JSON
    }
  };

  /**
   * Format the JSON content
   */
  const formatJson = () => {
    if (editorRef.current && monacoRef.current) {
      editorRef.current.getAction('editor.action.formatDocument').run();
    }
  };

  /**
   * Validate JSON manually
   */
  const validateJson = () => {
    if (editorRef.current && monacoRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        monacoRef.current.editor.setModelMarkers(model, 'json', []);
        // Trigger validation
        setTimeout(() => {
          const markers = monacoRef.current.editor.getModelMarkers({ resource: model.uri });
          const errors = markers.map(marker => ({
            line: marker.startLineNumber,
            column: marker.startColumn,
            message: marker.message,
            severity: marker.severity
          }));

          setValidationErrors(errors);
          const hasErrors = errors.some(
            error => error.severity === monacoRef.current.MarkerSeverity.Error
          );
          setIsValidJson(!hasErrors);

          if (onValidationChange) {
            onValidationChange({
              isValid: !hasErrors,
              errors: errors
            });
          }
        }, 100);
      }
    }
  };

  return (
    <div className={`monaco-json-editor ${className}`}>
      {/* Editor Toolbar */}
      <div className="flex items-center justify-between p-2 bg-gray-50 border-b border-gray-200 rounded-t-md">
        <div className="flex items-center space-x-2">
          <Icon name="document-text" className="h-4 w-4 text-gray-500" />
          <span className="text-sm font-medium text-gray-700">
            {t('admin.editor.jsonEditor', 'JSON Editor')}
          </span>
          {!isValidJson && (
            <div className="flex items-center space-x-1">
              <Icon name="exclamation-triangle" className="h-4 w-4 text-red-500" />
              <span className="text-sm text-red-600">
                {t('admin.editor.invalidJson', 'Invalid JSON')}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center space-x-2">
          <button
            type="button"
            onClick={formatJson}
            disabled={readOnly}
            className="inline-flex items-center px-2 py-1 text-xs font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title={t('admin.editor.formatJson', 'Format JSON')}
          >
            <Icon name="sparkles" className="h-3 w-3 mr-1" />
            {t('admin.editor.format', 'Format')}
          </button>

          <button
            type="button"
            onClick={validateJson}
            className="inline-flex items-center px-2 py-1 text-xs font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
            title={t('admin.editor.validateJson', 'Validate JSON')}
          >
            <Icon name="check-circle" className="h-3 w-3 mr-1" />
            {t('admin.editor.validate', 'Validate')}
          </button>
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="border border-gray-300 rounded-b-md overflow-hidden">
        <Editor
          height={height}
          language="json"
          theme={theme}
          value={jsonString}
          onChange={handleEditorChange}
          onMount={handleEditorDidMount}
          options={{
            readOnly,
            minimap: { enabled: showMinimap },
            wordWrap: wordWrap ? 'on' : 'off',
            scrollBeyondLastLine: false,
            fontSize: 14,
            lineNumbers: 'on',
            folding: true,
            bracketMatching: 'always',
            autoClosingBrackets: 'always',
            autoClosingQuotes: 'always',
            formatOnPaste: false,
            formatOnType: false,
            tabSize: 2,
            insertSpaces: true,
            detectIndentation: false,
            renderWhitespace: 'selection',
            scrollbar: {
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 8
            }
          }}
          loading={
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
              <span className="ml-2 text-gray-600">
                {t('admin.editor.loadingEditor', 'Loading editor...')}
              </span>
            </div>
          }
        />
      </div>

      {/* Validation Errors Display */}
      {validationErrors.length > 0 && (
        <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-md">
          <div className="flex items-start">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400 mt-0.5" />
            <div className="ml-2">
              <h4 className="text-sm font-medium text-red-800">
                {t('admin.editor.validationErrors', 'Validation Errors')}
              </h4>
              <div className="mt-1 text-sm text-red-700">
                <ul className="list-disc list-inside space-y-1">
                  {validationErrors.map((error, index) => (
                    <li key={index}>
                      {t('admin.editor.errorAtLine', 'Line {{line}}: {{message}}', {
                        line: error.line,
                        message: error.message
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MonacoJsonEditor;
