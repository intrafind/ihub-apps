import React from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';
import { highlightVariables } from '../utils/highlightVariables';

const PromptModal = ({ prompt, onClose, isFavorite, onToggleFavorite, t }) => {
  if (!prompt) return null;
  const handleShare = () => {
    const url = `${window.location.origin}/prompts?id=${encodeURIComponent(prompt.id)}`;
    navigator.clipboard.writeText(url);
    alert(t('pages.promptsList.linkCopied', 'Link copied!'));
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg max-w-lg w-full p-6 animate-fade-in mx-4">
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-xl font-semibold flex items-center">
            <Icon name={prompt.icon || 'clipboard'} className="w-6 h-6 mr-2" />
            {prompt.name}
          </h2>
          <button onClick={onClose} aria-label={t('common.cancel', 'Cancel')}>
            <Icon name="x" />
          </button>
        </div>
        <p className="text-gray-700 mb-4 whitespace-pre-line">
          {highlightVariables(prompt.description || prompt.prompt)}
        </p>
        <pre className="bg-gray-100 p-3 rounded whitespace-pre-wrap break-words mb-4">
{prompt.prompt}
        </pre>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={() => {
              navigator.clipboard.writeText(prompt.prompt.replace('[content]', ''));
              onClose();
              alert(t('pages.promptsList.copied', 'Copied!'));
            }}
            className="px-3 py-1 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700"
          >
            {t('pages.promptsList.copyPrompt', 'Copy prompt')}
          </button>
          {prompt.appId && (
            <Link
              to={`/apps/${prompt.appId}?prefill=${encodeURIComponent(prompt.prompt.replace('[content]', ''))}`}
              className="px-3 py-1 text-sm border border-indigo-600 text-indigo-600 rounded hover:bg-indigo-50 flex items-center"
              onClick={onClose}
            >
              {t('pages.promptsList.useInApp', 'Open app')}
            </Link>
          )}
          <button
            onClick={() => { onToggleFavorite(prompt.id); }}
            className="px-3 py-1 text-sm border border-indigo-600 text-indigo-600 rounded hover:bg-indigo-50 flex items-center"
          >
            <Icon name="star" className={isFavorite ? 'text-yellow-500' : 'text-gray-600'} solid={isFavorite} />
          </button>
          <button
            onClick={handleShare}
            className="px-3 py-1 text-sm border border-indigo-600 text-indigo-600 rounded hover:bg-indigo-50 flex items-center"
            aria-label={t('pages.promptsList.sharePrompt', 'Share prompt')}
          >
            <Icon name="share" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default PromptModal;
