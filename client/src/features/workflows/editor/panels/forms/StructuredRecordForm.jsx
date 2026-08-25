import { useId, useState } from 'react';
import FormField from './FormField';

/**
 * Config form for `structured-record` nodes.
 *
 * Takes the JSON a preceding prompt node extracted for the current document,
 * optionally validates it against a JSON Schema, and appends it as a record
 * to a state array (default `_records`) for later reporting.
 */
function StructuredRecordForm({ config, onChange, variables }) {
  const schemaFieldId = useId();
  const [schemaText, setSchemaText] = useState(() => {
    try {
      return config.schema ? JSON.stringify(config.schema, null, 2) : '';
    } catch {
      return '';
    }
  });
  const [schemaError, setSchemaError] = useState(null);

  const handleSchemaChange = text => {
    setSchemaText(text);
    if (!text.trim()) {
      onChange({ ...config, schema: undefined });
      setSchemaError(null);
      return;
    }
    try {
      onChange({ ...config, schema: JSON.parse(text) });
      setSchemaError(null);
    } catch (e) {
      // Keep the text so the user can finish typing; config stays unchanged.
      setSchemaError(e.message);
    }
  };

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  return (
    <div className="space-y-3">
      <FormField
        label="Extraction Input Path"
        value={config.inputPath}
        onChange={v => onChange({ ...config, inputPath: v })}
        placeholder="$.data._extractionOutput"
        helpText="State path of the JSON the previous prompt node produced. Default: $.data._extractionOutput"
      />
      <FormField
        label="Source Document Path"
        value={config.sourcePath}
        onChange={v => onChange({ ...config, sourcePath: v })}
        placeholder="e.g. $.data._currentDoc"
        helpText="State path of the document being processed (used for docId, title, URL). Default: $.data._loopItem"
      />
      <FormField
        label="Source System"
        type="select"
        value={config.sourceSystem || ''}
        onChange={v => onChange({ ...config, sourceSystem: v || undefined })}
        options={[
          { value: '', label: 'Auto-detect' },
          { value: 'ifinder', label: 'iFinder' },
          { value: 'upload', label: 'Upload' }
        ]}
        helpText="Where the documents come from. Auto-detect reads it from the document itself."
      />
      <FormField
        label="Iteration Index Path"
        value={config.iterationIndexPath}
        onChange={v => onChange({ ...config, iterationIndexPath: v })}
        placeholder="e.g. $.data._docIndex"
        helpText="State path of the loop counter, stored on each record. Default: $.data._loopIndex"
      />
      <FormField
        label="Records Variable"
        value={config.recordsVar}
        onChange={v => onChange({ ...config, recordsVar: v })}
        placeholder="_records"
        suggestions={variables}
        helpText="State array each finished record is appended to. Default: _records"
      />
      <div>
        <label htmlFor={schemaFieldId} className={labelClass}>
          Validation Schema (JSON)
        </label>
        <textarea
          id={schemaFieldId}
          value={schemaText}
          onChange={e => handleSchemaChange(e.target.value)}
          rows={8}
          placeholder='{"type": "object", "properties": {...}, "required": [...]}'
          className={`${inputClass} font-mono`}
        />
        {schemaError && <p className="text-xs text-red-500 mt-0.5">{schemaError}</p>}
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Optional JSON Schema the extraction must match. Records that fail are kept but marked as
          failed. Leave empty to skip validation.
        </p>
      </div>
    </div>
  );
}

export default StructuredRecordForm;
