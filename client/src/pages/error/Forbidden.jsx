import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../shared/components/Icon';

const Forbidden = () => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="text-indigo-600 mb-4">
        <Icon name="ban" size="2xl" className="w-24 h-24" />
      </div>
      <h1 className="text-4xl font-bold mb-2">{t('errors.forbidden.title', 'Forbidden')}</h1>
      <p className="text-xl mb-6 text-center">
        {t('errors.forbidden.message', 'Access to this resource is forbidden.')}
      </p>
      <Link
        to="/"
        className="bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700 transition-colors"
      >
        {t('errors.forbidden.goBack', 'Go Back')}
      </Link>
    </div>
  );
};

export default Forbidden;
