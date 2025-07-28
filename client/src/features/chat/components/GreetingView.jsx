
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/** Simple greeting component used when there are no messages */
const GreetingView = ({ welcomeMessage }) => {
  const { t } = useTranslation();

  let title;
  let subtitle;

  if (typeof welcomeMessage === 'object' && welcomeMessage !== null) {
    title = welcomeMessage.title || '';
    subtitle = welcomeMessage.subtitle || '';
  } else if (typeof welcomeMessage === 'string') {
    title = welcomeMessage;
    subtitle = t('pages.appChat.noMessagesSubtitle', 'Start a conversation by sending a message!');
  } else {
    title = t('pages.appChat.noMessagesTitle', 'Welcome!');
    subtitle = t('pages.appChat.noMessagesSubtitle', 'Start a conversation by sending a message!');
  }

  return (
    <div className="text-center text-gray-500 space-y-6 w-full">
      <div className="px-4">
        <Icon name="chat-bubble" size="3xl" className="mx-auto mb-4 text-gray-400" />
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-sm max-w-md mx-auto">{subtitle}</p>
      </div>
    </div>
  );
};

export default GreetingView;
