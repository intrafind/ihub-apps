import { useState } from 'react';
import Icon from '../../../shared/components/Icon';

/**
 * Create/edit form for a user-owned prompt (save-to-library, #1037/#1038).
 * Unlike admin-curated prompts, these are plain strings (no localization,
 * variables, or output schema) — kept intentionally simple for v1.
 */
function UserPromptFormModal({ prompt, onClose, onSave, t }) {
  const isEditing = Boolean(prompt);
  const [name, setName] = useState(prompt?.name || '');
  const [description, setDescription] = useState(prompt?.description || '');
  const [promptText, setPromptText] = useState(prompt?.prompt || '');
  const [visibility, setVisibility] = useState(prompt?.visibility || 'private');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async e => {
    e.preventDefault();
    if (!name.trim() || !promptText.trim()) {
      setError(
        t('pages.promptsList.userPrompts.validationError', 'Name and prompt text are required')
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        prompt: promptText.trim(),
        visibility
      });
    } catch (err) {
      setError(
        err.userFriendlyMessage ||
          err.message ||
          t('pages.promptsList.userPrompts.saveError', 'Failed to save prompt')
      );
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg max-w-lg w-full p-6 animate-fade-in max-h-[85vh] flex flex-col">
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {isEditing
              ? t('pages.promptsList.userPrompts.editTitle', 'Edit prompt')
              : t('pages.promptsList.userPrompts.saveTitle', 'Save a new prompt')}
          </h2>
          <button
            onClick={onClose}
            aria-label={t('common.cancel', 'Cancel')}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <Icon name="x" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('pages.promptsList.userPrompts.nameLabel', 'Name')}
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={200}
              className="block w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg text-sm px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              placeholder={t(
                'pages.promptsList.userPrompts.namePlaceholder',
                'e.g. Weekly summary'
              )}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('pages.promptsList.userPrompts.descriptionLabel', 'Description (optional)')}
            </label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={2000}
              className="block w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg text-sm px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              placeholder={t(
                'pages.promptsList.userPrompts.descriptionPlaceholder',
                'What is this prompt for?'
              )}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('pages.promptsList.userPrompts.promptLabel', 'Prompt')}
            </label>
            <textarea
              value={promptText}
              onChange={e => setPromptText(e.target.value)}
              maxLength={20000}
              rows={6}
              className="block w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg text-sm px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              placeholder={t(
                'pages.promptsList.userPrompts.promptPlaceholder',
                'Write your prompt text here...'
              )}
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('pages.promptsList.userPrompts.visibilityLabel', 'Visibility')}
            </span>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  name="visibility"
                  value="private"
                  checked={visibility === 'private'}
                  onChange={() => setVisibility('private')}
                />
                {t('pages.promptsList.userPrompts.visibilityPrivate', 'Private (only me)')}
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  name="visibility"
                  value="shared"
                  checked={visibility === 'shared'}
                  onChange={() => setVisibility('shared')}
                />
                {t('pages.promptsList.userPrompts.visibilityShared', 'Shared (everyone)')}
              </label>
            </div>
          </div>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default UserPromptFormModal;
