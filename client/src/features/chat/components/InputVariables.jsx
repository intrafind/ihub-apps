import { useTranslation } from 'react-i18next';

/**
 * A component to handle user input variables for chat applications
 */
const InputVariables = ({ variables, setVariables, localizedVariables, className = '' }) => {
  const { t } = useTranslation();

  if (!localizedVariables || localizedVariables.length === 0) {
    return null;
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {localizedVariables.map(variable => (
        <div key={variable.name} className="flex flex-col">
          <label className="mb-1 text-sm font-medium text-gray-700">
            {variable.localizedLabel}
            {variable.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          {variable.predefinedValues ? (
            <select
              value={variables[variable.name] || ''}
              onChange={e =>
                setVariables({
                  ...variables,
                  [variable.name]: e.target.value
                })
              }
              className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
              required={variable.required}
            >
              <option value="">
                {t('variables.selectLabel', { label: variable.localizedLabel })}
              </option>
              {variable.predefinedValues.map(option => (
                <option key={option.value} value={option.value}>
                  {option.localizedLabel}
                </option>
              ))}
            </select>
          ) : variable.type === 'text' ? (
            <textarea
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              value={variables[variable.name] || ''}
              onChange={e =>
                setVariables({
                  ...variables,
                  [variable.name]: e.target.value
                })
              }
              rows={4}
              className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
              placeholder={
                variable.localizedPlaceholder ||
                t('variables.enterLabel', { label: variable.localizedLabel })
              }
              required={variable.required}
            />
          ) : (
            <input
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              type="text"
              value={variables[variable.name] || ''}
              onChange={e =>
                setVariables({
                  ...variables,
                  [variable.name]: e.target.value
                })
              }
              className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
              placeholder={
                variable.localizedPlaceholder ||
                t('variables.enterLabel', { label: variable.localizedLabel })
              }
              required={variable.required}
            />
          )}
          {variable.localizedDescription && (
            <p className="mt-1 text-xs text-gray-500">{variable.localizedDescription}</p>
          )}
        </div>
      ))}
    </div>
  );
};

export default InputVariables;
