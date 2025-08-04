import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import MagicPromptLoader from '../../../shared/components/MagicPromptLoader';

/**
 * A dropdown menu component for chat input actions (upload, magic prompt, etc.)
 * Consolidates multiple action buttons into a clean "+" menu interface
 */
const ChatInputActionsMenu = ({
  // Upload props
  uploadEnabled = false,
  onToggleUploader,
  showUploader = false,
  
  // Magic prompt props
  magicPromptEnabled = false,
  onMagicPrompt,
  showUndoMagicPrompt = false,
  onUndoMagicPrompt,
  magicPromptLoading = false,
  
  // General props
  disabled = false,
  isProcessing = false
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  const buttonRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target) && 
          buttonRef.current && !buttonRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Determine if we should show the menu or direct action
  const availableActions = [];
  
  if (uploadEnabled) {
    availableActions.push({
      key: 'upload',
      label: showUploader 
        ? t('common.hideUpload', 'Hide file upload')
        : t('common.toggleUpload', 'Toggle file upload'),
      icon: 'paper-clip',
      active: showUploader,
      action: onToggleUploader
    });
  }

  if (magicPromptEnabled && !showUndoMagicPrompt) {
    availableActions.push({
      key: 'magic-prompt',
      label: t('common.magicPrompt', 'Magic prompt'),
      icon: 'sparkles',
      loading: magicPromptLoading,
      action: onMagicPrompt
    });
  }

  if (showUndoMagicPrompt) {
    availableActions.push({
      key: 'undo-magic',
      label: t('common.undo', 'Undo'),
      icon: 'arrowLeft',
      action: onUndoMagicPrompt
    });
  }

  // If no actions available, don't render anything
  if (availableActions.length === 0) {
    return null;
  }

  // If only one action, show it directly without menu
  if (availableActions.length === 1) {
    const action = availableActions[0];
    return (
      <button
        type="button"
        onClick={action.action}
        disabled={disabled || isProcessing}
        className={`image-upload-button h-fit ${action.active ? 'active' : ''}`}
        title={action.label}
        aria-label={action.label}
      >
        {action.loading ? (
          <MagicPromptLoader />
        ) : (
          <Icon name={action.icon} size="md" />
        )}
      </button>
    );
  }

  // Multiple actions - show menu
  const handleToggleMenu = () => {
    setIsOpen(!isOpen);
  };

  const handleActionClick = (action) => {
    action.action();
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggleMenu}
        disabled={disabled || isProcessing}
        className={`image-upload-button h-fit ${isOpen ? 'active' : ''}`}
        title={t('common.moreActions', 'More actions')}
        aria-label={t('common.moreActions', 'More actions')}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <Icon name="plus" size="md" />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
          {availableActions.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={() => handleActionClick(action)}
              disabled={disabled || isProcessing}
              className={`w-full px-3 py-2 text-left hover:bg-gray-50 flex items-center space-x-2 ${
                action.active ? 'bg-blue-50 text-blue-600' : 'text-gray-700'
              }`}
            >
              {action.loading ? (
                <MagicPromptLoader />
              ) : (
                <Icon name={action.icon} size="sm" />
              )}
              <span className="text-sm">{action.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ChatInputActionsMenu;