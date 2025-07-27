import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../shared/components/Icon';

const NotFound = () => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="text-indigo-600 mb-4">
        <Icon name="face-frown" size="2xl" className="w-24 h-24" />
      </div>
      <h1 className="text-4xl font-bold mb-2">404</h1>
      <p className="text-xl mb-6">{t('errors.notFound.title', 'Page Not Found')}</p>
      <p className="text-gray-600 mb-8 text-center max-w-md">
        {t('errors.notFound.message', "We couldn't find the page you're looking for.")}
      </p>
      <Link
        to="/"
        className="bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700 transition-colors"
      >
        {t('errors.notFound.returnHome', 'Return Home')}
      </Link>
    </div>
  );
};

export default NotFound;
