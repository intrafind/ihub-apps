import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { deleteUserPrompt, duplicatePrompt } from '../../../api';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import useApps from '../../../shared/hooks/useApps';
import useFavorites from '../../../shared/hooks/useFavorites';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { pickDefaultChatApp } from '../../../utils/homePage';
import PromptEditorModal from '../components/PromptEditorModal';
import PromptShareDialog from '../components/PromptShareDialog';
import PromptVersionsModal from '../components/PromptVersionsModal';
import { promptErrorMessage } from '../utils/promptErrors';
import usePromptLauncher from './usePromptLauncher';
import usePromptPreferences from './usePromptPreferences';

/**
 * Everything one can do with a prompt in the library, and the dialogs that
 * go with it.
 *
 * - **use** asks for the prompt's variables, then opens a chat in the
 *   prompt's app — or the default app when it has none — with the final text
 *   in the input, not sent.
 * - **copy** asks for the variables, then copies the final text.
 * - **create / edit / share / duplicate / history / delete** open their
 *   dialogs; the server decides, and the `permissions` on each prompt only
 *   hide what it would refuse.
 *
 * @param {Object} options
 * @param {(prompt?: Object) => void} [options.onChanged] - Called after a
 *   prompt was created, changed, shared, restored or deleted.
 * @returns {Object} Handlers, the latest notice, and the `dialogs` to render.
 */
export default function usePromptActions({ onChanged } = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { apps } = useApps();
  const { uiConfig } = useUIConfig();
  const { favorites: favoriteAppIds } = useFavorites('ihub_favorite_apps');
  const { launch, dialog: variablesDialog } = usePromptLauncher();
  const { recordUsage } = usePromptPreferences();
  const [editing, setEditing] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [history, setHistory] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [notice, setNotice] = useState(null);

  const changed = useCallback(prompt => onChanged?.(prompt), [onChanged]);

  const use = useCallback(
    async prompt => {
      const result = await launch(prompt, {
        includeAppVariables: true,
        submitLabel: t('prompts.actions.openInChat', 'Open in chat')
      });
      if (!result) return;
      recordUsage(prompt.id);
      const appId = prompt.appId || pickDefaultChatApp(apps, favoriteAppIds, uiConfig)?.id;
      if (!appId) {
        setNotice({
          type: 'error',
          text: t('prompts.errors.noApp', 'There is no chat app to open this prompt in.')
        });
        return;
      }
      const params = new URLSearchParams();
      if (result.text) params.set('prefill', result.text);
      for (const [name, value] of Object.entries(result.appVariables || {})) {
        if (value !== '' && value !== null && value !== undefined) {
          params.set(`var_${name}`, String(value));
        }
      }
      const query = params.toString();
      navigate(`/apps/${encodeURIComponent(appId)}${query ? `?${query}` : ''}`);
    },
    [launch, recordUsage, apps, favoriteAppIds, uiConfig, navigate, t]
  );

  const copy = useCallback(
    async prompt => {
      const result = await launch(prompt, {
        submitLabel: t('pages.promptsList.copyPrompt', 'Copy')
      });
      if (!result) return null;
      try {
        await navigator.clipboard.writeText(result.text);
        recordUsage(prompt.id);
        return true;
      } catch (err) {
        console.error('Failed to copy prompt:', err);
        return false;
      }
    },
    [launch, recordUsage, t]
  );

  const create = useCallback((initial = {}) => setEditing({ initial }), []);
  const edit = useCallback(prompt => setEditing({ prompt }), []);
  const share = useCallback(prompt => setSharing(prompt), []);
  const showHistory = useCallback(prompt => setHistory(prompt), []);
  const remove = useCallback(prompt => setDeleting(prompt), []);

  const duplicate = useCallback(
    async prompt => {
      try {
        const copyOfPrompt = await duplicatePrompt(prompt.id, {
          language: i18n.language?.split('-')[0]
        });
        changed(copyOfPrompt);
        // Straight into the editor: a copy is made to be changed.
        setEditing({ prompt: copyOfPrompt });
      } catch (err) {
        setNotice({ type: 'error', text: promptErrorMessage(err, t) });
      }
    },
    [changed, i18n.language, t]
  );

  const confirmDelete = async () => {
    const prompt = deleting;
    setDeleting(null);
    try {
      await deleteUserPrompt(prompt.id);
      setNotice({ type: 'success', text: t('prompts.notices.deleted', 'Prompt deleted') });
      changed(null);
    } catch (err) {
      setNotice({ type: 'error', text: promptErrorMessage(err, t) });
    }
  };

  const dialogs = (
    <>
      {variablesDialog}
      {editing && (
        <PromptEditorModal
          prompt={editing.prompt}
          initial={editing.initial}
          onClose={() => setEditing(null)}
          onSaved={saved => {
            setEditing(null);
            setNotice({ type: 'success', text: t('prompts.notices.saved', 'Prompt saved') });
            changed(saved);
          }}
        />
      )}
      {sharing && (
        <PromptShareDialog
          prompt={sharing}
          onClose={() => setSharing(null)}
          onSaved={saved => {
            setSharing(null);
            setNotice({
              type: 'success',
              text: t('prompts.notices.shared', 'Sharing updated')
            });
            changed(saved);
          }}
        />
      )}
      {history && (
        <PromptVersionsModal
          prompt={history}
          canRestore={Boolean(history.permissions?.canEdit)}
          onClose={() => setHistory(null)}
          onRestored={restored => {
            setHistory(null);
            setNotice({
              type: 'success',
              text: t('prompts.notices.restored', 'Version restored')
            });
            changed(restored);
          }}
        />
      )}
      <ConfirmDialog
        isOpen={Boolean(deleting)}
        title={t('prompts.delete.title', 'Delete prompt?')}
        message={t('prompts.delete.message', {
          defaultValue:
            '“{{name}}” and its history will be deleted for you and everyone it is shared with.',
          name: deleting?.name || ''
        })}
        confirmLabel={t('common.delete', 'Delete')}
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={confirmDelete}
        onDeny={() => setDeleting(null)}
      />
    </>
  );

  return {
    use,
    copy,
    create,
    edit,
    share,
    duplicate,
    showHistory,
    remove,
    notice,
    clearNotice: () => setNotice(null),
    dialogs
  };
}
