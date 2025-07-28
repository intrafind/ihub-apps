
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';

/** Display a list of starter prompts for quick start */
const StarterPromptsView = ({ starterPrompts = [], onSelectPrompt }) => {
  const { t, i18n } = useTranslation();

  return (
    <div className="text-center text-gray-500 space-y-6 w-full">
      <div className="space-y-2">
        <Icon name="light-bulb" size="2xl" className="mx-auto mb-3 text-indigo-400" />
        <h3 className="text-xl font-semibold text-gray-700 mb-1">
          {t('pages.appChat.starterPromptsTitle', 'Starter Prompts')}
        </h3>
        <p className="text-sm text-gray-500 max-w-md mx-auto md:px-4">
          {t(
            'pages.appChat.starterPromptsSubtitle',
            'Choose a prompt below to get started quickly'
          )}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 w-full max-w-4xl mx-auto px-4 pb-4">
        {starterPrompts.map((sp, idx) => (
          <button
            key={idx}
            type="button"
            className="group relative p-4 text-left bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md hover:border-indigo-300 transition-all duration-200 transform hover:-translate-y-0.5 h-full min-h-[100px] flex flex-col"
            onClick={() =>
              onSelectPrompt &&
              onSelectPrompt({
                ...sp,
                message: getLocalizedContent(sp.message, i18n.language)
              })
            }
          >
            <div className="flex items-start space-x-3 h-full">
              <div className="flex-shrink-0 w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center group-hover:bg-indigo-200 transition-colors mt-0.5">
                <Icon name="sparkles" size="sm" className="text-indigo-600" />
              </div>
              <div className="flex-1 min-w-0 flex flex-col justify-start">
                <p className="font-semibold text-gray-900 text-sm leading-5 mb-1">
                  {getLocalizedContent(sp.title, i18n.language)}
                </p>
                <p
                  className="text-xs text-gray-500 leading-4 overflow-hidden"
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical'
                  }}
                >
                  {getLocalizedContent(sp.message, i18n.language)}
                </p>
              </div>
            </div>
            <div className="absolute inset-0 rounded-xl border border-transparent group-hover:border-indigo-200 transition-colors pointer-events-none"></div>
          </button>
        ))}
      </div>
    </div>
  );
};

export default StarterPromptsView;
