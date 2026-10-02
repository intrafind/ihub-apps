import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlusIcon, NoSymbolIcon } from '@heroicons/react/24/outline';
import { approveExpert, revokeExpert } from './tabsApi';
import { extractApiError, formatDateTime } from './fileHelpers';
import { MIN_REASON_LENGTH, buildExpertBody, validateExpertForm } from './detectionModel';
import EuAiActDialog from './EuAiActDialog';
import { Button, Notice, SectionCard, TABLE, TextField } from './EuAiActUi';

const EMPTY_FORM = Object.freeze({ userId: '', name: '', reason: '' });

/**
 * "Approved experts" panel of the Detection tab (CoP 2.1.2): users who may
 * run free-form text watermark detection. Approvals and revocations are
 * individual, audited calls; the list itself comes from the settings
 * (`settings.detection.experts`), which the parent reloads via `onChanged`.
 *
 * @param {Object} props
 * @param {Array<{ userId: string, name?: string, reason: string, approvedBy?: string,
 *   approvedByName?: string, approvedAt?: string }>} props.experts
 * @param {() => Promise<void>} props.onChanged - Reload settings (and status) after a change
 */
function DetectionExpertsPanel({ experts = [], onChanged }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState(null);
  const [message, setMessage] = useState(null);
  const userIdRef = useRef(null);

  const cancelLabel = t('admin.euAiAct.detection.dialog.cancel', 'Cancel');
  const closeLabel = t('admin.euAiAct.detection.dialog.close', 'Close dialog');

  const close = () => {
    if (busy) return;
    setDialog(null);
    setDialogError(null);
  };

  const openApprove = () => {
    setForm(EMPTY_FORM);
    setFormErrors({});
    setDialogError(null);
    setDialog({ type: 'approve' });
  };

  const handleApprove = async () => {
    const errors = validateExpertForm(form);
    setFormErrors(errors);
    if (errors.userId) {
      document.getElementById('eu-expert-user-id')?.focus();
      return;
    }
    if (errors.reason) {
      document.getElementById('eu-expert-reason')?.focus();
      return;
    }
    setBusy(true);
    setDialogError(null);
    try {
      const { expert } = await approveExpert(buildExpertBody(form));
      setDialog(null);
      setMessage({
        tone: 'success',
        text: t('admin.euAiAct.detection.experts.approved', '{{name}} is now an approved expert.', {
          name: expert?.name || form.userId
        })
      });
      await onChanged?.();
    } catch (err) {
      setDialogError(extractApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async expert => {
    setBusy(true);
    setDialogError(null);
    try {
      await revokeExpert(expert.userId);
      setDialog(null);
      setMessage({
        tone: 'success',
        text: t(
          'admin.euAiAct.detection.experts.revoked',
          'Expert access for {{name}} was revoked.',
          { name: expert.name || expert.userId }
        )
      });
      await onChanged?.();
    } catch (err) {
      setDialogError(extractApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const reasonLength = form.reason.trim().length;

  return (
    <SectionCard
      id="eu-detect-experts"
      title={t('admin.euAiAct.detection.experts.title', 'Approved experts')}
      description={t(
        'admin.euAiAct.detection.experts.description',
        'Experts may run free-form text watermark detection (CoP 2.1.2). Every approval needs a reason and is written to the audit log.'
      )}
      actions={
        <Button icon={UserPlusIcon} onClick={openApprove}>
          {t('admin.euAiAct.detection.experts.approve', 'Approve expert…')}
        </Button>
      }
    >
      <div aria-live="polite">{message && <Notice tone={message.tone} title={message.text} />}</div>
      <div className={TABLE.wrapper}>
        <table className={TABLE.table}>
          <caption className="sr-only">
            {t('admin.euAiAct.detection.experts.caption', 'Approved experts for text detection')}
          </caption>
          <thead className={TABLE.thead}>
            <tr>
              <th scope="col" className={TABLE.th}>
                {t('admin.euAiAct.detection.experts.colExpert', 'Expert')}
              </th>
              <th scope="col" className={TABLE.th}>
                {t('admin.euAiAct.detection.experts.colReason', 'Reason')}
              </th>
              <th scope="col" className={TABLE.th}>
                {t('admin.euAiAct.detection.experts.colApproved', 'Approved')}
              </th>
              <th scope="col" className={TABLE.thRight}>
                {t('admin.euAiAct.detection.experts.colActions', 'Actions')}
              </th>
            </tr>
          </thead>
          <tbody className={TABLE.tbody}>
            {experts.length === 0 && (
              <tr>
                <td colSpan={4} className={TABLE.empty}>
                  {t('admin.euAiAct.detection.experts.empty', 'No experts approved yet.')}
                </td>
              </tr>
            )}
            {experts.map(expert => (
              <tr key={expert.userId} className={TABLE.tr}>
                <td className={TABLE.td}>
                  <div className="text-gray-900 dark:text-gray-100">
                    {expert.name || expert.userId}
                  </div>
                  <div className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">
                    {expert.userId}
                  </div>
                </td>
                <td className={`${TABLE.td} break-words`}>{expert.reason}</td>
                <td className={TABLE.td}>
                  <div>
                    {t('admin.euAiAct.detection.experts.approvedBy', 'by {{name}}', {
                      name: expert.approvedByName || expert.approvedBy || '—'
                    })}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {formatDateTime(expert.approvedAt, locale)}
                  </div>
                </td>
                <td className={TABLE.tdRight}>
                  <Button
                    size="sm"
                    icon={NoSymbolIcon}
                    onClick={() => {
                      setDialogError(null);
                      setDialog({ type: 'revoke', expert });
                    }}
                    aria-label={t(
                      'admin.euAiAct.detection.experts.revokeAria',
                      'Revoke expert access for {{name}}',
                      { name: expert.name || expert.userId }
                    )}
                  >
                    {t('admin.euAiAct.detection.experts.revoke', 'Revoke')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <EuAiActDialog
        open={dialog?.type === 'approve'}
        title={t('admin.euAiAct.detection.experts.approveTitle', 'Approve an expert')}
        description={
          <p>
            {t(
              'admin.euAiAct.detection.experts.approveBody',
              'The user can then run free-form text watermark detection. Give the reason for the approval, e.g. the role or the case.'
            )}
          </p>
        }
        onClose={close}
        onSubmit={handleApprove}
        submitting={busy}
        submitLabel={t('admin.euAiAct.detection.experts.approveConfirm', 'Approve')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
        initialFocusRef={userIdRef}
      >
        <TextField
          ref={userIdRef}
          id="eu-expert-user-id"
          value={form.userId}
          onChange={value => setForm(prev => ({ ...prev, userId: value }))}
          label={t('admin.euAiAct.detection.experts.userId', 'User ID')}
          hint={t(
            'admin.euAiAct.detection.experts.userIdHint',
            'The ID of the user as shown in the user administration.'
          )}
          error={
            formErrors.userId
              ? t('admin.euAiAct.detection.experts.userIdRequired', 'Enter the user ID.')
              : undefined
          }
          autoComplete="off"
          required
          aria-required="true"
        />
        <TextField
          id="eu-expert-name"
          value={form.name}
          onChange={value => setForm(prev => ({ ...prev, name: value }))}
          label={t('admin.euAiAct.detection.experts.name', 'Display name (optional)')}
          autoComplete="off"
        />
        <TextField
          id="eu-expert-reason"
          multiline
          rows={3}
          value={form.reason}
          onChange={value => setForm(prev => ({ ...prev, reason: value }))}
          label={t('admin.euAiAct.detection.experts.reason', 'Reason')}
          hint={t(
            'admin.euAiAct.detection.experts.reasonHint',
            '{{length}} of at least {{min}} characters.',
            { length: reasonLength, min: MIN_REASON_LENGTH }
          )}
          error={
            formErrors.reason
              ? t(
                  'admin.euAiAct.detection.experts.reasonTooShort',
                  'Give a reason of at least {{min}} characters.',
                  { min: MIN_REASON_LENGTH }
                )
              : undefined
          }
          required
          aria-required="true"
        />
        {dialogError && (
          <Notice
            tone="error"
            role="alert"
            title={t(
              'admin.euAiAct.detection.experts.approveError',
              'The expert could not be approved.'
            )}
          >
            {dialogError.message && <p>{dialogError.message}</p>}
          </Notice>
        )}
      </EuAiActDialog>

      <EuAiActDialog
        open={dialog?.type === 'revoke'}
        danger
        focusCancel
        title={t('admin.euAiAct.detection.experts.revokeTitle', 'Revoke expert access?')}
        description={
          <p>
            {t(
              'admin.euAiAct.detection.experts.revokeBody',
              '{{name}} can no longer run free-form text watermark detection.',
              { name: dialog?.expert?.name || dialog?.expert?.userId || '' }
            )}
          </p>
        }
        onClose={close}
        onSubmit={() => handleRevoke(dialog.expert)}
        submitting={busy}
        submitLabel={t('admin.euAiAct.detection.experts.revokeConfirm', 'Revoke access')}
        cancelLabel={cancelLabel}
        closeLabel={closeLabel}
      >
        {dialogError && (
          <Notice
            tone="error"
            role="alert"
            title={t('admin.euAiAct.detection.experts.revokeError', 'Access could not be revoked.')}
          >
            {dialogError.message && <p>{dialogError.message}</p>}
          </Notice>
        )}
      </EuAiActDialog>
    </SectionCard>
  );
}

export default DetectionExpertsPanel;
