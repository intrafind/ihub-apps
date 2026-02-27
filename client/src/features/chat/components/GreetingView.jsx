import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
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

  // Parse subtitle as markdown to support links
  const subtitleHtml = subtitle ? marked.parseInline(subtitle) : '';

  return (
    <div className="text-center text-gray-500 dark:text-gray-400 space-y-6 w-full">
      <div className="px-4">
        <Icon
          name="chat-bubble"
          size="3xl"
          className="mx-auto mb-4 text-gray-400 dark:text-gray-500"
        />
        <h3 className="text-lg font-semibold mb-2 text-gray-700 dark:text-gray-200">{title}</h3>
        <p
          className="text-sm max-w-md mx-auto text-gray-500 dark:text-gray-400"
          dangerouslySetInnerHTML={{ __html: subtitleHtml }}
        />
      </div>
    </div>
  );
};

export default GreetingView;
