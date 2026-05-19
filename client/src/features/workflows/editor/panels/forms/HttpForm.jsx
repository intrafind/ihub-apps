import FormField from './FormField';

function HttpForm({ config, onChange }) {
  const auth = config.auth || {};
  const authType = auth.type || 'none';

  const onAuth = (field, value) => {
    onChange({ ...config, auth: { ...auth, [field]: value } });
  };

  return (
    <div className="space-y-3">
      <FormField
        label="URL"
        value={config.url}
        onChange={v => onChange({ ...config, url: v })}
        placeholder="https://..."
      />
      <FormField
        label="Method"
        type="select"
        value={config.method}
        onChange={v => onChange({ ...config, method: v })}
        options={['GET', 'POST', 'PUT', 'DELETE', 'PATCH']}
      />
      <FormField
        label="Headers"
        type="textarea"
        rows={4}
        value={config.headers}
        onChange={v => onChange({ ...config, headers: v })}
        placeholder="JSON object"
      />
      <FormField
        label="Body"
        type="textarea"
        rows={4}
        value={config.body}
        onChange={v => onChange({ ...config, body: v })}
        placeholder="Request body..."
      />

      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 pt-2 border-t border-gray-200 dark:border-gray-700">
        Authentication
      </h4>
      <FormField
        label="Type"
        type="select"
        value={authType}
        onChange={v => onAuth('type', v)}
        options={[
          { value: 'none', label: 'None' },
          { value: 'bearer', label: 'Bearer' },
          { value: 'basic', label: 'Basic' },
          { value: 'apiKey', label: 'API Key' }
        ]}
      />
      {authType === 'bearer' && (
        <FormField
          label="Token"
          value={auth.token}
          onChange={v => onAuth('token', v)}
          placeholder="Bearer token"
        />
      )}
      {authType === 'basic' && (
        <>
          <FormField label="Username" value={auth.username} onChange={v => onAuth('username', v)} />
          <FormField label="Password" value={auth.password} onChange={v => onAuth('password', v)} />
        </>
      )}
      {authType === 'apiKey' && (
        <>
          <FormField
            label="Header Name"
            value={auth.headerName}
            onChange={v => onAuth('headerName', v)}
            placeholder="e.g. X-API-Key"
          />
          <FormField label="Value" value={auth.value} onChange={v => onAuth('value', v)} />
        </>
      )}

      <FormField
        label="Timeout"
        type="number"
        value={config.timeout}
        onChange={v => onChange({ ...config, timeout: v })}
        min={1000}
        step={1000}
        placeholder="ms"
      />
      <FormField
        label="Response Type"
        type="select"
        value={config.responseType}
        onChange={v => onChange({ ...config, responseType: v })}
        options={[
          { value: 'json', label: 'JSON' },
          { value: 'text', label: 'Text' },
          { value: 'binary', label: 'Binary' }
        ]}
      />
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. httpResponse"
      />
      <FormField
        label="Fail on Error"
        type="checkbox"
        value={config.failOnError}
        onChange={v => onChange({ ...config, failOnError: v })}
      />
    </div>
  );
}

export default HttpForm;
