
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/** Displayed when a chat has no messages and no greeting */
const NoMessagesView = () => {
  const { t } = useTranslation();
  return (
    <div className="text-center text-gray-500 space-y-6 w-full">
      <div className="px-4">
        <Icon name="chat-bubble" size="3xl" className="mx-auto mb-4 text-gray-400" />
        <h3 className="text-lg font-semibold mb-2">
          {t('pages.appChat.noMessagesTitle', 'No Messages Yet')}
        </h3>
        <p className="text-sm max-w-md mx-auto">
          {t('pages.appChat.noMessagesSubtitle', 'Start a conversation by sending a message!')}
        </p>
      </div>
    </div>
  );
};

export default NoMessagesView;
