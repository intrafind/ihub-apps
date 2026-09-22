import FormField from './FormField';
import JsonField from './JsonField';

/**
 * Config form for `structured-record` nodes.
 *
 * Takes the JSON a preceding prompt node extracted for the current document,
 * optionally validates it against a JSON Schema, and appends it as a record
 * to a state array (default `_records`) for later reporting.
 */
function StructuredRecordForm({ config, onChange, variables }) {
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
      <JsonField
        label="Validation Schema (JSON)"
        expect="object"
        rows={8}
        value={config.schema}
        onChange={v => onChange({ ...config, schema: v })}
        placeholder={'{"type": "object", "properties": {...}, "required": [...]}'}
        helpText="Optional JSON Schema the extraction must match. Records that fail are kept but marked as failed. Leave empty to skip validation."
      />
    </div>
  );
}

export default StructuredRecordForm;
