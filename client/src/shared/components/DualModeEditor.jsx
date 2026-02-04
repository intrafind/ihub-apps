import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import MonacoJsonEditor from './MonacoJsonEditor';
import Icon from './Icon';

/**
 * DualModeEditor - A component that provides dual-mode editing (Form + JSON)
 * Allows users to toggle between a form-based interface and raw JSON editing
 *
 * @component
 * @param {Object} props - Component props
 * @param {Object} props.value - The current data object
 * @param {Function} props.onChange - Callback fired when data changes
 * @param {React.Component} props.formComponent - The form component to render in form mode
 * @param {Object} props.formProps - Props to pass to the form component
 * @param {Object} props.jsonSchema - JSON schema for validation (optional)
 * @param {string} props.defaultMode - Initial editing mode ('form' | 'json')
 * @param {boolean} props.allowModeSwitch - Whether mode switching is allowed
 * @param {Function} props.onModeChange - Callback fired when mode changes
 * @param {Function} props.onValidationChange - Callback fired when validation state changes
 * @param {string} props.title - Title for the editor section
 * @param {string} props.description - Description for the editor section
 * @param {boolean} props.showValidationSummary - Whether to show validation summary
 * @param {string} props.className - Additional CSS classes
 * @returns {React.Component} DualModeEditor component
 */
const DualModeEditor = ({
  value = {},
  onChange,
  formComponent: FormComponent,
  formProps = {},
  jsonSchema,
  defaultMode = 'form',
  allowModeSwitch = true,
  onModeChange,
  onValidationChange,
  title: _title,
  description: _description,
  showValidationSummary = true,
  className = ''
}) => {
  const { t } = useTranslation();
  const [editingMode, setEditingMode] = useState(defaultMode);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [validationState, setValidationState] = useState({ isValid: true, errors: [] });
  const initialValueRef = useRef(JSON.stringify(value));

  // Track changes to detect unsaved modifications
  useEffect(() => {
    const currentValueString = JSON.stringify(value);
    setHasUnsavedChanges(currentValueString !== initialValueRef.current);
  }, [value]);

  /**
   * Handle mode switching with confirmation for unsaved changes
   */
  const handleModeSwitch = newMode => {
    if (newMode === editingMode) return;

    if (hasUnsavedChanges) {
      setPendingModeSwitch(newMode);
      const shouldSwitch = window.confirm(
        t(
          'admin.editor.unsavedChangesWarning',
          'You have unsaved changes. Switching modes may cause data loss. Continue?'
        )
      );

      if (shouldSwitch) {
        performModeSwitch(newMode);
      }
      setPendingModeSwitch(null);
    } else {
      performModeSwitch(newMode);
    }
  };

  /**
   * Actually perform the mode switch
   */
  const performModeSwitch = newMode => {
    setEditingMode(newMode);
    initialValueRef.current = JSON.stringify(value);
    setHasUnsavedChanges(false);

    if (onModeChange) {
      onModeChange(newMode);
    }
  };

  /**
   * Handle data changes from form or JSON editor
   */
  const handleDataChange = newData => {
    if (onChange) {
      onChange(newData);
    }
  };

  /**
   * Handle validation state changes
   */
  const handleValidationChange = validation => {
    setValidationState(validation);

    if (onValidationChange) {
      onValidationChange(validation);
    }
  };

  /**
   * Reset to initial state
   */
  const handleReset = () => {
    const shouldReset = window.confirm(
      t('admin.editor.resetConfirmation', 'Are you sure you want to reset all changes?')
    );

    if (shouldReset) {
      try {
        const initialValue = JSON.parse(initialValueRef.current);
        handleDataChange(initialValue);
        setHasUnsavedChanges(false);
      } catch (error) {
        console.error('Error resetting to initial value:', error);
      }
    }
  };

  return (
    <div className={`dual-mode-editor ${className}`}>
      {/* Header with title, description, and mode toggle */}
      <div className="mb-6">
        {/* Mode Toggle and Actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            {allowModeSwitch && (
              <div className="flex items-center bg-gray-100 rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => handleModeSwitch('form')}
                  className={`flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    editingMode === 'form'
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Icon name="document-text" className="h-4 w-4 mr-2" />
                  {t('admin.editor.formMode', 'Form')}
                </button>
                <button
                  type="button"
                  onClick={() => handleModeSwitch('json')}
                  className={`flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    editingMode === 'json'
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Icon name="code-bracket" className="h-4 w-4 mr-2" />
                  {t('admin.editor.jsonMode', 'JSON')}
                </button>
              </div>
            )}

            {/* Status indicators */}
            <div className="flex items-center space-x-3">
              {hasUnsavedChanges && (
                <div className="flex items-center text-amber-600">
                  <Icon name="exclamation-triangle" className="h-4 w-4 mr-1" />
                  <span className="text-sm">
                    {t('admin.editor.unsavedChanges', 'Unsaved changes')}
                  </span>
                </div>
              )}

              {!validationState.isValid && (
                <div className="flex items-center text-red-600">
                  <Icon name="x-circle" className="h-4 w-4 mr-1" />
                  <span className="text-sm">
                    {t('admin.editor.validationErrors', 'Validation errors')}
                  </span>
                </div>
              )}

              {validationState.isValid && !hasUnsavedChanges && (
                <div className="flex items-center text-green-600">
                  <Icon name="check-circle" className="h-4 w-4 mr-1" />
                  <span className="text-sm">{t('admin.editor.allValid', 'All valid')}</span>
                </div>
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center space-x-2">
            {hasUnsavedChanges && (
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="arrow-path" className="h-4 w-4 mr-1" />
                {t('admin.editor.reset', 'Reset')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Editor Content */}
      <div className="editor-content">
        {editingMode === 'form' ? (
          <div className="form-editor">
            {FormComponent ? (
              <FormComponent
                value={value}
                onChange={handleDataChange}
                onValidationChange={handleValidationChange}
                {...formProps}
              />
            ) : (
              <div className="p-8 text-center text-gray-500 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
                <Icon name="document-text" className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                <p className="text-lg font-medium mb-2">
                  {t('admin.editor.noFormComponent', 'No Form Component')}
                </p>
                <p className="text-sm">
                  {t(
                    'admin.editor.noFormComponentDesc',
                    'No form component provided for this editor.'
                  )}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="json-editor">
            <MonacoJsonEditor
              value={value}
              onChange={handleDataChange}
              onValidationChange={handleValidationChange}
              schema={jsonSchema}
              height="600px"
              theme="vs"
              showMinimap={false}
              wordWrap={true}
            />
          </div>
        )}
      </div>

      {/* Validation Summary */}
      {showValidationSummary && !validationState.isValid && validationState.errors.length > 0 && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-md">
          <div className="flex">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h4 className="text-sm font-medium text-red-800">
                {t('admin.editor.validationSummary', 'Validation Summary')}
              </h4>
              <div className="mt-2 text-sm text-red-700">
                <p>
                  {t('admin.editor.errorCount', '{{count}} error(s) found:', {
                    count: validationState.errors.length
                  })}
                </p>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  {validationState.errors.slice(0, 5).map((error, index) => (
                    <li key={index}>{error.message}</li>
                  ))}
                  {validationState.errors.length > 5 && (
                    <li className="text-gray-600">
                      {t('admin.editor.moreErrors', '... and {{count}} more', {
                        count: validationState.errors.length - 5
                      })}
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DualModeEditor;
