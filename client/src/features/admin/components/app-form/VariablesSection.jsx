import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../../shared/components/DynamicLanguageEditor';
import Icon from '../../../../shared/components/Icon';

/**
 * VariablesSection - Input variable list editor for the App form.
 * Extracted from AppFormEditor.jsx (see #1781) as a self-contained slice:
 * owns its own immutable-update handlers since they only ever touch
 * `app.variables`.
 */
function VariablesSection({ app, onChange }) {
  const { t } = useTranslation();

  const handleVariableChange = (index, field, value) => {
    onChange({
      ...app,
      variables: app.variables.map((variable, i) =>
        i === index ? { ...variable, [field]: value } : variable
      )
    });
  };

  const handleVariablePredefinedValueChange = (variableIndex, valueIndex, field, value) => {
    onChange({
      ...app,
      variables: app.variables.map((variable, i) =>
        i === variableIndex
          ? {
              ...variable,
              predefinedValues: variable.predefinedValues.map((predefinedValue, j) =>
                j === valueIndex ? { ...predefinedValue, [field]: value } : predefinedValue
              )
            }
          : variable
      )
    });
  };

  const addPredefinedValue = variableIndex => {
    onChange({
      ...app,
      variables: app.variables.map((variable, i) =>
        i === variableIndex
          ? {
              ...variable,
              predefinedValues: [
                ...(variable.predefinedValues || []),
                {
                  label: { en: '' },
                  value: ''
                }
              ]
            }
          : variable
      )
    });
  };

  const removePredefinedValue = (variableIndex, valueIndex) => {
    onChange({
      ...app,
      variables: app.variables.map((variable, i) =>
        i === variableIndex
          ? {
              ...variable,
              predefinedValues: variable.predefinedValues.filter((_, j) => j !== valueIndex)
            }
          : variable
      )
    });
  };

  const addVariable = () => {
    onChange({
      ...app,
      variables: [
        ...(app.variables || []),
        {
          name: '',
          label: { en: '' },
          type: 'string',
          required: false
          // Don't initialize defaultValue and predefinedValues - they'll be added only when needed
        }
      ]
    });
  };

  const removeVariable = index => {
    onChange({
      ...app,
      variables: app.variables.filter((_, i) => i !== index)
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.variables', 'Variables')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.variablesDesc', 'Configure input variables for dynamic prompts')}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-4">
            {(app.variables || []).map((variable, index) => (
              <div
                key={index}
                className="border border-gray-200 dark:border-gray-600 rounded-lg p-4"
              >
                <div className="flex justify-between items-start mb-4">
                  <h4 className="text-sm font-medium text-gray-900">
                    {t('admin.apps.edit.variable', 'Variable')} {index + 1}
                  </h4>
                  <button
                    type="button"
                    onClick={() => removeVariable(index)}
                    className="text-red-600 hover:text-red-800"
                  >
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>

                <div className="grid grid-cols-6 gap-4">
                  <div className="col-span-6 sm:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.apps.edit.variableName', 'Name')}
                    </label>
                    <input
                      type="text"
                      value={variable.name || ''}
                      onChange={e => handleVariableChange(index, 'name', e.target.value)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    />
                  </div>

                  <div className="col-span-6 sm:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.apps.edit.variableType', 'Type')}
                    </label>
                    <select
                      value={variable.type || 'string'}
                      onChange={e => handleVariableChange(index, 'type', e.target.value)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    >
                      <option value="string">{t('admin.apps.edit.typeString', 'String')}</option>
                      <option value="text">{t('admin.apps.edit.typeText', 'Text')}</option>
                      <option value="select">{t('admin.apps.edit.typeSelect', 'Select')}</option>
                      <option value="date">{t('admin.apps.edit.typeDate', 'Date')}</option>
                      <option value="number">{t('admin.apps.edit.typeNumber', 'Number')}</option>
                    </select>
                  </div>

                  <div className="col-span-6 sm:col-span-2 flex items-end">
                    <div className="flex items-center h-5">
                      <input
                        type="checkbox"
                        checked={variable.required || false}
                        onChange={e => handleVariableChange(index, 'required', e.target.checked)}
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                        {t('admin.apps.edit.required', 'Required')}
                      </label>
                    </div>
                  </div>

                  <div className="col-span-6">
                    <DynamicLanguageEditor
                      label={t('admin.apps.edit.variableLabel', 'Label')}
                      value={variable.label || {}}
                      onChange={value => handleVariableChange(index, 'label', value)}
                      placeholder={{
                        en: 'Enter variable label in English',
                        de: 'Variablenbeschriftung auf Deutsch eingeben'
                      }}
                    />
                  </div>

                  <div className="col-span-6">
                    <DynamicLanguageEditor
                      label={t('admin.apps.edit.defaultValue', 'Default Value')}
                      value={variable.defaultValue || {}}
                      onChange={value => handleVariableChange(index, 'defaultValue', value)}
                      placeholder={{
                        en: 'Enter default value in English',
                        de: 'Standardwert auf Deutsch eingeben'
                      }}
                    />
                  </div>

                  <div className="col-span-6">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t('admin.apps.edit.predefinedValues', 'Predefined Values')}
                    </label>
                    <p className="text-xs text-gray-500 mb-2">
                      {variable.type === 'select'
                        ? t(
                            'admin.apps.edit.predefinedValuesHintSelect',
                            'Options that will be available in the dropdown menu.'
                          )
                        : t(
                            'admin.apps.edit.predefinedValuesHint',
                            'Optional suggested values that can be used as autocomplete options.'
                          )}
                    </p>
                    <div className="space-y-2">
                      {(variable.predefinedValues || []).map((predefinedValue, valueIndex) => (
                        <div key={valueIndex} className="flex items-center space-x-2">
                          <div className="flex-1">
                            <DynamicLanguageEditor
                              label={`${t('admin.apps.edit.option', 'Option')} ${valueIndex + 1}`}
                              value={predefinedValue.label || {}}
                              onChange={value =>
                                handleVariablePredefinedValueChange(
                                  index,
                                  valueIndex,
                                  'label',
                                  value
                                )
                              }
                              placeholder={{
                                en: 'Option label',
                                de: 'Options-Beschriftung'
                              }}
                            />
                          </div>
                          <div className="w-32">
                            <input
                              type="text"
                              value={predefinedValue.value || ''}
                              onChange={e =>
                                handleVariablePredefinedValueChange(
                                  index,
                                  valueIndex,
                                  'value',
                                  e.target.value
                                )
                              }
                              placeholder={t('admin.apps.edit.value', 'Value')}
                              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => removePredefinedValue(index, valueIndex)}
                            className="text-red-600 hover:text-red-800"
                          >
                            <Icon name="trash" className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addPredefinedValue(index)}
                        className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                      >
                        <Icon name="plus" className="h-4 w-4 mr-2" />
                        {t('admin.apps.edit.addOption', 'Add Option')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={addVariable}
              className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              <Icon name="plus" className="h-4 w-4 mr-2" />
              {t('admin.apps.edit.addVariable', 'Add Variable')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VariablesSection;
