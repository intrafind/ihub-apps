import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ExportConversationMenu from './ExportConversationMenu';

const ChatActionsMenu = ({
  onClearChat,
  onToggleConfig,
  onShare,
  showShareButton = false,
  showConfigButton = true,
  showClearButton = true,
  showParametersButton = false,
  parametersVisible = false,
  messages = [],
  exportSettings = {},
  onToggleCanvas,
  onToggleParameters,
  showCanvasButton = false
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClick = e => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false);
        setShowExport(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className="bg-gray-200 hover:bg-gray-300 text-gray-800 p-2 rounded-full flex items-center justify-center h-10 w-10"
        title={t('common.menu', 'Menu')}
        aria-label={t('common.menu', 'Menu')}
      >
        <Icon name="menu" size="sm" />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 bg-white border border-gray-200 rounded shadow-lg z-20 min-w-40">
          {showConfigButton && (
            <button
              onClick={() => {
                onToggleConfig?.();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
            >
              <Icon name="settings" size="sm" /> {t('settings.title')}
            </button>
          )}
          {showCanvasButton && (
            <button
              onClick={() => {
                onToggleCanvas?.();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
            >
              <Icon name="document-text" size="sm" /> {t('pages.appChat.canvas', 'Canvas')}
            </button>
          )}
          {showClearButton && (
            <button
              onClick={() => {
                onClearChat?.();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
            >
              <Icon name="trash" size="sm" /> {t('pages.appChat.clear')}
            </button>
          )}
          {showParametersButton && (
            <button
              onClick={() => {
                onToggleParameters?.();
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap ${
                parametersVisible ? 'bg-gray-100' : ''
              }`}
              aria-pressed={parametersVisible}
            >
              <Icon name="sliders" size="sm" /> {t('pages.appChat.parameters')}
            </button>
          )}
          {showShareButton && (
            <button
              onClick={() => {
                onShare?.();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
            >
              <Icon name="share" size="sm" /> {t('pages.appChat.share', 'Share')}
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setShowExport(v => !v)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
            >
              <Icon name="download" size="sm" />
              {t('pages.appChat.export.conversation', 'Export')}
            </button>
            {showExport && (
              <ExportConversationMenu
                messages={messages}
                settings={exportSettings}
                onClose={() => setShowExport(false)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatActionsMenu;
