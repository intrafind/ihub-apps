import React from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import TurndownService from 'turndown';
import { markdownToHtml, htmlToMarkdown, isMarkdown } from '../../../utils/markdownUtils';

const turndownService = new TurndownService();

const ExportConversationMenu = ({ messages = [], settings = {}, onClose }) => {
  const { t } = useTranslation();

  const buildMeta = () => ({
    model: settings.model,
    style: settings.style,
    outputFormat: settings.outputFormat,
    temperature: settings.temperature,
    variables: settings.variables
  });

  const asJSON = () => JSON.stringify({ ...buildMeta(), messages }, null, 2);

  const asJSONL = () => {
    const lines = [JSON.stringify({ meta: buildMeta() })];
    messages.forEach(m => lines.push(JSON.stringify(m)));
    return lines.join('\n');
  };

  const asMarkdown = () =>
    messages
      .map(
        m => `**${m.role}**: ${isMarkdown(m.content) ? m.content : htmlToMarkdown(m.content || '')}`
      )
      .join('\n\n');

  const asHTML = () =>
    messages
      .map(m => `<p><strong>${m.role}:</strong> ${markdownToHtml(m.content)}</p>`) // markdownToHtml handles null
      .join('');

  const handleExport = format => {
    let data = '';
    let mime = 'text/plain';
    let ext = format;

    switch (format) {
      case 'json':
        data = asJSON();
        mime = 'application/json';
        ext = 'json';
        break;
      case 'jsonl':
        data = asJSONL();
        mime = 'application/json';
        ext = 'jsonl';
        break;
      case 'markdown':
        data = asMarkdown();
        mime = 'text/markdown';
        ext = 'md';
        break;
      case 'html':
        data = asHTML();
        mime = 'text/html';
        ext = 'html';
        break;
      default:
        return;
    }

    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    onClose?.();
  };

  return (
    <div className="absolute left-full top-0 ml-2 bg-white border border-gray-200 rounded shadow-lg z-20">
      <button
        onClick={() => handleExport('json')}
        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
      >
        <Icon name="code" size="sm" /> {t('pages.appChat.exportJSON', 'as JSON')}
      </button>
      <button
        onClick={() => handleExport('jsonl')}
        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
      >
        <Icon name="code" size="sm" /> {t('pages.appChat.exportJSONL', 'as JSONL')}
      </button>
      <button
        onClick={() => handleExport('markdown')}
        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
      >
        <Icon name="code" size="sm" /> {t('pages.appChat.exportMarkdown', 'as Markdown')}
      </button>
      <button
        onClick={() => handleExport('html')}
        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
      >
        <Icon name="code" size="sm" /> {t('pages.appChat.exportHTML', 'as HTML')}
      </button>
    </div>
  );
};

export default ExportConversationMenu;
