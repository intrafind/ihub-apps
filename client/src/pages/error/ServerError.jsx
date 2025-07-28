import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../shared/components/Icon';

const ServerError = () => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="text-indigo-600 mb-4">
        <Icon name="exclamation-triangle" size="2xl" className="w-24 h-24" />
      </div>
      <h1 className="text-4xl font-bold mb-2">{t('errors.serverError.title', 'Server Error')}</h1>
      <p className="text-xl mb-2 text-center">
        {t('errors.serverError.message', 'Something went wrong on our end.')}
      </p>
      <p className="text-gray-600 mb-8 text-center">
        {t('errors.serverError.subtitle', 'Please try again later.')}
      </p>
      <Link
        to="/"
        className="bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700 transition-colors"
      >
        {t('errors.serverError.retry', 'Retry')}
      </Link>
    </div>
  );
};

export default ServerError;
