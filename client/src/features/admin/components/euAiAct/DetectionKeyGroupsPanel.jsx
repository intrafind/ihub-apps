import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  CommandLineIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon
} from '@heroicons/react/24/outline';
import {
  createKeyGroup,
  deleteKeyGroup,
  exportKeyBundle,
  fetchKeyGroups,
  importKeyBundle,
  revealVllmConfig,
  rotateKeyGroup,
  updateKeyGroup
} from './tabsApi';
import { downloadJsonFile, extractApiError, formatDateTime, readFileAsText } from './fileHelpers';
import {
  CONTEXT_WIDTH_RANGE,
  MIN_PASSPHRASE_LENGTH,
  buildKeyGroupBody,
  buildVllmArgument,
  keyBundleFileName,
  parseKeyBundle,
  validateExportForm,
  validateKeyGroupForm
} from './detectionModel';
import EuAiActDialog from './EuAiActDialog';
import {
  Button,
  CodeBlock,
  LoadingRow,
  Notice,
  NumberField,
  SectionCard,
  StatusPill,
  TABLE,
  TextField
} from './EuAiActUi';

const EMPTY_GROUP_FORM = Object.freeze({ id: '', name: '', detectorUrl: '', contextWidth: '' });
const EMPTY_EXPORT_FORM = Object.freeze({ passphrase: '', confirm: '' });
const EMPTY_IMPORT_FORM = Object.freeze({ bundle: null, fileName: '', passphrase: '' });
const FILE_INPUT_CLASS =
  'block w-full text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-50 dark:file:bg-indigo-900/40 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-indigo-700 dark:file:text-indigo-300 hover:file:bg-indigo-100';

/**
 * "Text watermark key groups" panel of the Detection tab (concept §8.4).
 *
 * A key group holds the secret keys vLLM uses to watermark text and iHub
 * uses to detect it. Groups can be shared between the installations of one
 * customer through encrypted key bundles. Rotation adds a key version;
 * older versions stay detect-only.
 *
 * @param {Object} props
 * @param {() => void} [props.onChanged] - Called after any change (refreshes the page status)
 */
function DetectionKeyGroupsPanel({ onChanged }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [groups, setGroups] = useState([]);
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState(null);
  const [message, setMessage] = useState(null);
  const [groupForm, setGroupForm] = useState(EMPTY_GROUP_FORM);
  const [groupErrors, setGroupErrors] = useState({});
  const [exportForm, setExportForm] = useState(EMPTY_EXPORT_FORM);
  const [exportErrors, setExportErrors] = useState({});
  const [importForm, setImportForm] = useState(EMPTY_IMPORT_FORM);
  const [importErrors, setImportErrors] = useState({});
  const [revealed, setRevealed] = useState(null);
  const firstGroupFieldRef = useRef(null);
  const exportFieldRef = useRef(null);
  const importFieldRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchKeyGroups();
      const list = Array.isArray(data?.keyGroups) ? data.keyGroups : [];
      setGroups(list);
      setSelected(prev => prev.filter(id => list.some(group => group.id === id)));
      setLoadError('');
      setLoadState('ready');
    } catch (err) {
      setLoadError(extractApiError(err).message);
      setLoadState(prev => (prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const cancelLabel = t('admin.euAiAct.detection.dialog.cancel', 'Cancel');
  const closeLabel = t('admin.euAiAct.detection.dialog.close', 'Close dialog');

  const close = () => {
    if (busy) return;
    setDialog(null);
    setDialogError(null);
    // Never keep a revealed secret in memory longer than the dialog is open.
    setRevealed(null);
  };

  const open = next => {
    setDialogError(null);
    setDialog(next);
  };

  const afterChange = async text => {
    setMessage({ tone: 'success', text });
    await load();
    onChanged?.();
  };

  /** Run a dialog action with busy/error handling. */
  const runDialogAction = async action => {
    setBusy(true);
    setDialogError(null);
    try {
      await action();
    } catch (err) {
      setDialogError(extractApiError(err));
    } finally {
      setBusy(false);
    }
  };

  // ── Create / edit ────────────────────────────────────────────────────

  const openCreate = () => {
    setGroupForm(EMPTY_GROUP_FORM);
    setGroupErrors({});
    open({ type: 'create' });
  };

  const openEdit = group => {
    setGroupForm({
      id: group.id,
      name: group.name || '',
      detectorUrl: group.detectorUrl || '',
      contextWidth: Number.isInteger(group.contextWidth) ? group.contextWidth : ''
    });
    setGroupErrors({});
    open({ type: 'edit', group });
  };

  const handleSaveGroup = () => {
    const isNew = dialog?.type === 'create';
    const errors = validateKeyGroupForm(groupForm, { isNew });
    setGroupErrors(errors);
    const firstInvalid = ['id', 'detectorUrl', 'contextWidth'].find(key => errors[key]);
    if (firstInvalid) {
      document.getElementById(`eu-keygroup-${firstInvalid}`)?.focus();
      return;
    }
    void runDialogAction(async () => {
      const body = buildKeyGroupBody(groupForm, { isNew });
      const { keyGroup } = isNew
        ? await createKeyGroup(body)
        : await updateKeyGroup(dialog.group.id, body);
      setDialog(null);
      await afterChange(
        isNew
          ? t('admin.euAiAct.detection.keyGroups.created', 'Key group {{id}} created.', {
              id: keyGroup?.id || body.id
            })
          : t('admin.euAiAct.detection.keyGroups.updated', 'Key group {{id}} updated.', {
              id: dialog.group.id
            })
      );
    });
  };

  // ── Rotate / delete ──────────────────────────────────────────────────

  const handleRotate = group =>
    runDialogAction(async () => {
      const { keyGroup } = await rotateKeyGroup(group.id);
      setDialog(null);
      await afterChange(
        t(
          'admin.euAiAct.detection.keyGroups.rotated',
          'Key group {{id}} now watermarks with version {{version}}. Update the vLLM configuration of the models that use it.',
          { id: group.id, version: keyGroup?.activeVersion ?? '' }
        )
      );
    });

  const handleDelete = group =>
    runDialogAction(async () => {
      await deleteKeyGroup(group.id);
      setDialog(null);
      await afterChange(
        t('admin.euAiAct.detection.keyGroups.deleted', 'Key group {{id}} deleted.', {
          id: group.id
        })
      );
    });

  // ── vLLM config ──────────────────────────────────────────────────────

  const handleReveal = group =>
    runDialogAction(async () => {
      const config = await revealVllmConfig(group.id);
      setRevealed(config);
    });

  // ── Export / import ──────────────────────────────────────────────────

  const openExport = () => {
    setExportForm(EMPTY_EXPORT_FORM);
    setExportErrors({});
    open({ type: 'export' });
  };

  const handleExport = () => {
    const errors = validateExportForm({ ids: selected, ...exportForm });
    setExportErrors(errors);
    if (errors.passphrase) {
      document.getElementById('eu-keygroup-export-passphrase')?.focus();
      return;
    }
    if (errors.confirm) {
      document.getElementById('eu-keygroup-export-confirm')?.focus();
      return;
    }
    if (errors.ids) return;
    void runDialogAction(async () => {
      const bundle = await exportKeyBundle(selected, exportForm.passphrase);
      downloadJsonFile(keyBundleFileName(selected), bundle);
      setDialog(null);
      setExportForm(EMPTY_EXPORT_FORM);
      setMessage({
        tone: 'success',
        text: t(
          'admin.euAiAct.detection.keyGroups.exported',
          'Encrypted key bundle downloaded ({{ids}}). Share the passphrase through a different channel than the file.',
          { ids: selected.join(', ') }
        )
      });
    });
  };

  const openImport = () => {
    setImportForm(EMPTY_IMPORT_FORM);
    setImportErrors({});
    open({ type: 'import' });
  };

  const handleImportFile = async event => {
    const file = event.target.files?.[0];
    if (!file) {
      setImportForm(prev => ({ ...prev, bundle: null, fileName: '' }));
      return;
    }
    try {
      const bundle = parseKeyBundle(await readFileAsText(file));
      setImportForm(prev => ({ ...prev, bundle, fileName: file.name }));
      setImportErrors(prev => ({ ...prev, file: undefined }));
    } catch {
      setImportForm(prev => ({ ...prev, bundle: null, fileName: file.name }));
      setImportErrors(prev => ({ ...prev, file: 'invalidJson' }));
    }
  };

  const handleImport = () => {
    const errors = {};
    if (!importForm.bundle) errors.file = importErrors.file || 'required';
    if (!importForm.passphrase) errors.passphrase = 'required';
    setImportErrors(errors);
    if (errors.file) {
      document.getElementById('eu-keygroup-import-file')?.focus();
      return;
    }
    if (errors.passphrase) {
      document.getElementById('eu-keygroup-import-passphrase')?.focus();
      return;
    }
    void runDialogAction(async () => {
      const { keyGroups } = await importKeyBundle(importForm.bundle, importForm.passphrase);
      setDialog(null);
      setImportForm(EMPTY_IMPORT_FORM);
      const ids = (keyGroups || []).map(group => group.id).join(', ');
      await afterChange(
        ids
          ? t('admin.euAiAct.detection.keyGroups.imported', 'Imported key groups: {{ids}}.', {
              ids
            })
          : t(
              'admin.euAiAct.detection.keyGroups.importedNone',
              'The bundle contained no new key groups.'
            )
      );
    });
  };

  const toggleSelected = id =>
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  // ── Render helpers ───────────────────────────────────────────────────

  const renderDialogError = title =>
    dialogError ? (
      <Notice tone="error" role="alert" title={title}>
        {dialogError.message && <p>{dialogError.message}</p>}
        {dialogError.details?.length > 0 && (
          <ul className="list-disc pl-5">
            {dialogError.details.map(detail => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}
      </Notice>
    ) : null;

  const groupFieldError = key => {
    switch (groupErrors[key]) {
      case 'required':
        return t(
          'admin.euAiAct.detection.keyGroups.validation.required',
          'This field is required.'
        );
      case 'idPattern':
        return t(
          'admin.euAiAct.detection.keyGroups.validation.idPattern',
          'Use 1–64 lowercase letters, digits, dots, dashes or underscores.'
        );
      case 'url':
        return t(
          'admin.euAiAct.detection.keyGroups.validation.url',
          'Enter an absolute http(s) URL, or leave the field empty.'
        );
      case 'contextWidth':
        return t(
          'admin.euAiAct.detection.keyGroups.validation.contextWidth',
          'Enter a whole number between {{min}} and {{max}}.',
          CONTEXT_WIDTH_RANGE
        );
      default:
        return undefined;
    }
  };

  const versionStatus = status =>
    status === 'active' ? (
      <StatusPill tone="success">
        {t('admin.euAiAct.detection.keyGroups.versionActive', 'active')}
      </StatusPill>
    ) : (
      <StatusPill tone="neutral">
        {t('admin.euAiAct.detection.keyGroups.versionDetectOnly', 'detect only')}
      </StatusPill>
    );

  const isNewGroup = dialog?.type === 'create';

  return (
    <SectionCard
      id="eu-detect-keygroups"
      title={t('admin.euAiAct.detection.keyGroups.title', 'Text watermark key groups')}
      description={t(
        'admin.euAiAct.detection.keyGroups.description',
        'vLLM watermarks text with the active key of a key group; iHub detects it with every version. Share a key group with the other installations of the same customer through an encrypted key bundle.'
      )}
      actions={
        <>
          <Button icon={PlusIcon} onClick={openCreate}>
            {t('admin.euAiAct.detection.keyGroups.create', 'Create key group')}
          </Button>
          <Button icon={ArrowDownTrayIcon} disabled={selected.length === 0} onClick={openExport}>
            {t('admin.euAiAct.detection.keyGroups.exportSelected', 'Export selected ({{number}})', {
              number: selected.length
            })}
          </Button>
          <Button icon={ArrowUpTrayIcon} onClick={openImport}>
            {t('admin.euAiAct.detection.keyGroups.import', 'Import bundle')}
          </Button>
        </>
      }
    >
      <div aria-live="polite">{message && <Notice tone={message.tone} title={message.text} />}</div>

      {loadState === 'loading' && (
        <LoadingRow label={t('admin.euAiAct.detection.keyGroups.loading', 'Loading key groups…')} />
      )}
      {loadState === 'error' && (
        <Notice
          tone="error"
          role="alert"
          title={t(
            'admin.euAiAct.detection.keyGroups.loadError',
            'The key groups could not be loaded.'
          )}
        >
          {loadError && <p>{loadError}</p>}
          <div className="pt-2">
            <Button icon={ArrowPathIcon} onClick={load}>
              {t('admin.euAiAct.detection.retry', 'Try again')}
            </Button>
          </div>
        </Notice>
      )}
      {loadState === 'ready' && loadError && (
        <Notice
          tone="warning"
          title={t(
            'admin.euAiAct.detection.keyGroups.refreshError',
            'The list could not be refreshed: {{error}}',
            { error: loadError }
          )}
        />
      )}

      {loadState === 'ready' && (
        <div className={TABLE.wrapper}>
          <table className={TABLE.table}>
            <caption className="sr-only">
              {t('admin.euAiAct.detection.keyGroups.caption', 'Text watermark key groups')}
            </caption>
            <thead className={TABLE.thead}>
              <tr>
                <th scope="col" className={TABLE.th}>
                  <span className="sr-only">
                    {t('admin.euAiAct.detection.keyGroups.colSelect', 'Select for export')}
                  </span>
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.keyGroups.colId', 'ID')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.keyGroups.colName', 'Name')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.keyGroups.colDetectorUrl', 'Detector URL')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.keyGroups.colActiveVersion', 'Active version')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('admin.euAiAct.detection.keyGroups.colVersions', 'Versions')}
                </th>
                <th scope="col" className={TABLE.thRight}>
                  {t('admin.euAiAct.detection.keyGroups.colActions', 'Actions')}
                </th>
              </tr>
            </thead>
            <tbody className={TABLE.tbody}>
              {groups.length === 0 && (
                <tr>
                  <td colSpan={7} className={TABLE.empty}>
                    {t('admin.euAiAct.detection.keyGroups.empty', 'No key groups yet.')}
                  </td>
                </tr>
              )}
              {groups.map(group => (
                <tr key={group.id} className={TABLE.tr}>
                  <td className={TABLE.td}>
                    <input
                      type="checkbox"
                      checked={selected.includes(group.id)}
                      onChange={() => toggleSelected(group.id)}
                      aria-label={t(
                        'admin.euAiAct.detection.keyGroups.selectAria',
                        'Select {{id}} for export',
                        { id: group.id }
                      )}
                      className="h-4 w-4 rounded-sm border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                    />
                  </td>
                  <td className={`${TABLE.tdMono} text-gray-900 dark:text-gray-100`}>
                    {group.id}
                    {Number.isInteger(group.contextWidth) && (
                      <div className="font-sans text-xs text-gray-500 dark:text-gray-400">
                        {t(
                          'admin.euAiAct.detection.keyGroups.contextWidthValue',
                          'Context width {{width}}',
                          { width: group.contextWidth }
                        )}
                      </div>
                    )}
                  </td>
                  <td className={TABLE.td}>{group.name || '—'}</td>
                  <td className={TABLE.tdMono}>
                    {group.detectorUrl || (
                      <StatusPill tone="warning">
                        {t(
                          'admin.euAiAct.detection.keyGroups.noDetector',
                          'No detector: text cannot be checked'
                        )}
                      </StatusPill>
                    )}
                  </td>
                  <td className={TABLE.td}>{group.activeVersion ?? '—'}</td>
                  <td className={TABLE.td}>
                    <ul className="space-y-1">
                      {(group.versions || []).map(version => (
                        <li
                          key={version.version}
                          className="flex flex-wrap items-center gap-1.5"
                          title={version.fingerprint || undefined}
                        >
                          <span className="font-mono text-xs">
                            {t('admin.euAiAct.detection.keyGroups.versionNumber', 'v{{version}}', {
                              version: version.version
                            })}
                          </span>
                          {versionStatus(version.status)}
                          {version.importedFrom && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {t('admin.euAiAct.detection.keyGroups.importedTag', 'imported')}
                            </span>
                          )}
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {formatDateTime(version.createdAt, locale, { dateStyle: 'medium' })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className={TABLE.tdRight}>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        size="sm"
                        icon={PencilSquareIcon}
                        onClick={() => openEdit(group)}
                        aria-label={t('admin.euAiAct.detection.keyGroups.editAria', 'Edit {{id}}', {
                          id: group.id
                        })}
                      >
                        {t('admin.euAiAct.detection.keyGroups.edit', 'Edit')}
                      </Button>
                      <Button
                        size="sm"
                        icon={ArrowPathIcon}
                        onClick={() => open({ type: 'rotate', group })}
                        aria-label={t(
                          'admin.euAiAct.detection.keyGroups.rotateAria',
                          'Rotate the key of {{id}}',
                          { id: group.id }
                        )}
                      >
                        {t('admin.euAiAct.detection.keyGroups.rotate', 'Rotate')}
                      </Button>
                      <Button
                        size="sm"
                        icon={CommandLineIcon}
                        onClick={() => {
                          setRevealed(null);
                          open({ type: 'vllm', group });
                        }}
                        aria-label={t(
                          'admin.euAiAct.detection.keyGroups.vllmAria',
                          'Show the vLLM config of {{id}}',
                          { id: group.id }
                        )}
                      >
                        {t('admin.euAiAct.detection.keyGroups.vllm', 'Show vLLM config')}
                      </Button>
                      <Button
                        size="sm"
                        icon={TrashIcon}
                        onClick={() => open({ type: 'delete', group })}
                        aria-label={t(
                          'admin.euAiAct.detection.keyGroups.deleteAria',
                          'Delete {{id}}',
                          { id: group.id }
                        )}
                      >
                        {t('admin.euAiAct.detection.keyGroups.delete', 'Delete')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create / edit ─────────────────────────────────────────────── */}
      <EuAiActDialog
        open={dialog?.type === 'create' || dialog?.type === 'edit'}
        title={
          isNewGroup
            ? t('admin.euAiAct.detection.keyGroups.createTitle', 'Create key group')
            : t('admin.euAiAct.detection.keyGroups.editTitle', 'Edit key group {{id}}', {
                id: dialog?.group?.id || ''
              })
        }
        description={
          isNewGroup ? (
            <p>
              {t(
                'admin.euAiAct.detection.keyGroups.createBody',
                'iHub generates a new secret key (version 1). Assign the key group to vLLM models in the model editor.'
              )}
            </p>
          ) : undefined
        }
        onClose={close}
        onSubmit={handleSaveGroup}
        submitting={busy}
        submitLabel={
          isNewGroup
            ? t('admin.euAiAct.detection.keyGroups.createConfirm', 'Create')
            : t('admin.euAiAct.detection.keyGroups.editConfirm', 'Save')
        }
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
        initialFocusRef={firstGroupFieldRef}
      >
        {isNewGroup && (
          <TextField
            ref={firstGroupFieldRef}
            id="eu-keygroup-id"
            mono
            value={groupForm.id}
            onChange={value => setGroupForm(prev => ({ ...prev, id: value }))}
            label={t('admin.euAiAct.detection.keyGroups.id', 'ID')}
            hint={t(
              'admin.euAiAct.detection.keyGroups.idHint',
              'Lowercase letters, digits, dots, dashes and underscores, e.g. customer-a. Cannot be changed later.'
            )}
            error={groupFieldError('id')}
            autoComplete="off"
            required
            aria-required="true"
          />
        )}
        <TextField
          ref={isNewGroup ? undefined : firstGroupFieldRef}
          id="eu-keygroup-name"
          value={groupForm.name}
          onChange={value => setGroupForm(prev => ({ ...prev, name: value }))}
          label={t('admin.euAiAct.detection.keyGroups.name', 'Name')}
          maxLength={200}
        />
        <TextField
          id="eu-keygroup-detectorUrl"
          type="url"
          mono
          value={groupForm.detectorUrl}
          onChange={value => setGroupForm(prev => ({ ...prev, detectorUrl: value }))}
          label={t('admin.euAiAct.detection.keyGroups.detectorUrl', 'Detector URL (optional)')}
          hint={t(
            'admin.euAiAct.detection.keyGroups.detectorUrlHint',
            'Watermark detector service that checks text with the keys of this group (reference implementation: docker/watermark-detector). Without it, text marked with this key group cannot be detected.'
          )}
          error={groupFieldError('detectorUrl')}
        />
        <NumberField
          id="eu-keygroup-contextWidth"
          value={groupForm.contextWidth}
          onChange={value => setGroupForm(prev => ({ ...prev, contextWidth: value }))}
          min={CONTEXT_WIDTH_RANGE.min}
          max={CONTEXT_WIDTH_RANGE.max}
          step={1}
          label={t('admin.euAiAct.detection.keyGroups.contextWidth', 'Context width (optional)')}
          hint={t(
            'admin.euAiAct.detection.keyGroups.contextWidthHint',
            'Number of preceding tokens that seed the watermark ({{min}}–{{max}}); must match the vLLM configuration. Empty uses the default.',
            CONTEXT_WIDTH_RANGE
          )}
          error={groupFieldError('contextWidth')}
        />
        {renderDialogError(
          t('admin.euAiAct.detection.keyGroups.saveError', 'The key group could not be saved.')
        )}
      </EuAiActDialog>

      {/* ── Rotate ────────────────────────────────────────────────────── */}
      <EuAiActDialog
        open={dialog?.type === 'rotate'}
        focusCancel
        title={t('admin.euAiAct.detection.keyGroups.rotateTitle', 'Rotate the key of {{id}}?', {
          id: dialog?.group?.id || ''
        })}
        description={
          <p>
            {t(
              'admin.euAiAct.detection.keyGroups.rotateBody',
              'A new key version becomes active for watermarking. Older versions stay detect-only, so older text remains detectable. Afterwards, update the vLLM configuration of every model that uses this key group and export a new bundle for the other installations.'
            )}
          </p>
        }
        onClose={close}
        onSubmit={() => handleRotate(dialog.group)}
        submitting={busy}
        submitLabel={t('admin.euAiAct.detection.keyGroups.rotateConfirm', 'Rotate key')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
      >
        {renderDialogError(
          t('admin.euAiAct.detection.keyGroups.rotateError', 'The key could not be rotated.')
        )}
      </EuAiActDialog>

      {/* ── Delete ────────────────────────────────────────────────────── */}
      <EuAiActDialog
        open={dialog?.type === 'delete'}
        danger
        focusCancel
        title={t('admin.euAiAct.detection.keyGroups.deleteTitle', 'Delete key group {{id}}?', {
          id: dialog?.group?.id || ''
        })}
        description={
          <p>
            {t(
              'admin.euAiAct.detection.keyGroups.deleteBody',
              'All key versions are deleted. Text marked with this key group can no longer be detected by this installation. This cannot be undone; export a bundle first if you may need the keys again.'
            )}
          </p>
        }
        onClose={close}
        onSubmit={() => handleDelete(dialog.group)}
        submitting={busy}
        submitLabel={t('admin.euAiAct.detection.keyGroups.deleteConfirm', 'Delete key group')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
      >
        {renderDialogError(
          t('admin.euAiAct.detection.keyGroups.deleteError', 'The key group could not be deleted.')
        )}
      </EuAiActDialog>

      {/* ── vLLM config (reveals the secret) ──────────────────────────── */}
      <EuAiActDialog
        open={dialog?.type === 'vllm'}
        size="lg"
        danger={!revealed}
        focusCancel
        title={t('admin.euAiAct.detection.keyGroups.vllmTitle', 'vLLM configuration of {{id}}', {
          id: dialog?.group?.id || ''
        })}
        description={
          <p>
            {t(
              'admin.euAiAct.detection.keyGroups.vllmBody',
              'Start vLLM with this argument so the model watermarks its output with the active key of this key group.'
            )}
          </p>
        }
        onClose={close}
        onSubmit={revealed ? undefined : () => handleReveal(dialog.group)}
        submitting={busy}
        submitLabel={t('admin.euAiAct.detection.keyGroups.vllmReveal', 'Reveal configuration')}
        cancelLabel={revealed ? t('admin.euAiAct.detection.dialog.done', 'Close') : cancelLabel}
        closeLabel={closeLabel}
      >
        <Notice
          tone="warning"
          title={t(
            'admin.euAiAct.detection.keyGroups.vllmWarningTitle',
            'This reveals the secret watermark key.'
          )}
        >
          <p>
            {t(
              'admin.euAiAct.detection.keyGroups.vllmWarningBody',
              'Anyone with this configuration can create and detect watermarks of this key group. Treat it like a password: do not paste it into tickets, chats or version control. Revealing it is written to the audit log.'
            )}
          </p>
        </Notice>
        {revealed && (
          <CodeBlock
            code={buildVllmArgument(revealed.watermarkConfig)}
            label={t(
              'admin.euAiAct.detection.keyGroups.vllmCodeLabel',
              'vLLM argument (key version {{version}})',
              { version: revealed.version ?? '' }
            )}
            copyLabel={t('admin.euAiAct.detection.copy', 'Copy')}
            copiedLabel={t('admin.euAiAct.detection.copied', 'Copied')}
            copyFailedLabel={t('admin.euAiAct.detection.copyFailed', 'Copying failed')}
          />
        )}
        {renderDialogError(
          t('admin.euAiAct.detection.keyGroups.vllmError', 'The configuration could not be loaded.')
        )}
      </EuAiActDialog>

      {/* ── Export ────────────────────────────────────────────────────── */}
      <EuAiActDialog
        open={dialog?.type === 'export'}
        title={t('admin.euAiAct.detection.keyGroups.exportTitle', 'Export encrypted key bundle')}
        description={
          <>
            <p>
              {t(
                'admin.euAiAct.detection.keyGroups.exportBody',
                'The bundle contains every key version of the selected key groups, encrypted with your passphrase. Import it into the other installations of the same customer.'
              )}
            </p>
            <p className="font-medium">
              {t('admin.euAiAct.detection.keyGroups.exportSelection', 'Selected: {{ids}}', {
                ids: selected.join(', ')
              })}
            </p>
          </>
        }
        onClose={close}
        onSubmit={handleExport}
        submitting={busy}
        submitLabel={t('admin.euAiAct.detection.keyGroups.exportConfirm', 'Export and download')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
        initialFocusRef={exportFieldRef}
      >
        <TextField
          ref={exportFieldRef}
          id="eu-keygroup-export-passphrase"
          type="password"
          autoComplete="new-password"
          value={exportForm.passphrase}
          onChange={value => setExportForm(prev => ({ ...prev, passphrase: value }))}
          label={t('admin.euAiAct.detection.keyGroups.passphrase', 'Passphrase')}
          hint={t(
            'admin.euAiAct.detection.keyGroups.passphraseHint',
            'At least {{min}} characters. It is not stored; without it the bundle cannot be imported.',
            { min: MIN_PASSPHRASE_LENGTH }
          )}
          error={
            exportErrors.passphrase
              ? t(
                  'admin.euAiAct.detection.keyGroups.passphraseTooShort',
                  'Use at least {{min}} characters.',
                  { min: MIN_PASSPHRASE_LENGTH }
                )
              : undefined
          }
          required
          aria-required="true"
        />
        <TextField
          id="eu-keygroup-export-confirm"
          type="password"
          autoComplete="new-password"
          value={exportForm.confirm}
          onChange={value => setExportForm(prev => ({ ...prev, confirm: value }))}
          label={t('admin.euAiAct.detection.keyGroups.passphraseConfirm', 'Repeat passphrase')}
          error={
            exportErrors.confirm
              ? t(
                  'admin.euAiAct.detection.keyGroups.passphraseMismatch',
                  'The passphrases do not match.'
                )
              : undefined
          }
          required
          aria-required="true"
        />
        {renderDialogError(
          t('admin.euAiAct.detection.keyGroups.exportError', 'The bundle could not be exported.')
        )}
      </EuAiActDialog>

      {/* ── Import ────────────────────────────────────────────────────── */}
      <EuAiActDialog
        open={dialog?.type === 'import'}
        title={t('admin.euAiAct.detection.keyGroups.importTitle', 'Import key bundle')}
        description={
          <p>
            {t(
              'admin.euAiAct.detection.keyGroups.importBody',
              'Import a bundle exported by another installation of the same customer. This installation then watermarks and detects with the same keys.'
            )}
          </p>
        }
        onClose={close}
        onSubmit={handleImport}
        submitting={busy}
        submitLabel={t('admin.euAiAct.detection.keyGroups.importConfirm', 'Import')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
        initialFocusRef={importFieldRef}
      >
        <div>
          <label
            htmlFor="eu-keygroup-import-file"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('admin.euAiAct.detection.keyGroups.importFile', 'Bundle file (.json)')}
          </label>
          <input
            ref={importFieldRef}
            id="eu-keygroup-import-file"
            type="file"
            accept=".json,application/json"
            onChange={handleImportFile}
            aria-invalid={importErrors.file ? true : undefined}
            aria-describedby={importErrors.file ? 'eu-keygroup-import-file-error' : undefined}
            className={`mt-1 ${FILE_INPUT_CLASS}`}
          />
          {importErrors.file && (
            <p
              id="eu-keygroup-import-file-error"
              className="mt-1 text-xs text-red-600 dark:text-red-400"
            >
              {importErrors.file === 'invalidJson'
                ? t(
                    'admin.euAiAct.detection.keyGroups.importInvalid',
                    'This file is not a key bundle (invalid JSON).'
                  )
                : t(
                    'admin.euAiAct.detection.keyGroups.importFileRequired',
                    'Choose a bundle file.'
                  )}
            </p>
          )}
          {importForm.bundle && importForm.fileName && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('admin.euAiAct.detection.keyGroups.importSelected', 'Selected: {{name}}', {
                name: importForm.fileName
              })}
            </p>
          )}
        </div>
        <TextField
          id="eu-keygroup-import-passphrase"
          type="password"
          autoComplete="off"
          value={importForm.passphrase}
          onChange={value => setImportForm(prev => ({ ...prev, passphrase: value }))}
          label={t('admin.euAiAct.detection.keyGroups.passphrase', 'Passphrase')}
          error={
            importErrors.passphrase
              ? t(
                  'admin.euAiAct.detection.keyGroups.passphraseRequired',
                  'Enter the passphrase of the bundle.'
                )
              : undefined
          }
          required
          aria-required="true"
        />
        {renderDialogError(
          t('admin.euAiAct.detection.keyGroups.importError', 'The bundle could not be imported.')
        )}
      </EuAiActDialog>
    </SectionCard>
  );
}

export default DetectionKeyGroupsPanel;
