import Icon from '../../../../shared/components/Icon';

/**
 * JwtProvidersSection - JWT provider list for pure JWT (header-less) authentication,
 * rendered inside the Proxy/JWT Authentication Settings card.
 */
function JwtProvidersSection({ config, onChange, t }) {
  const addJwtProvider = () => {
    const newProvider = {
      name: '',
      header: 'Authorization',
      issuer: '',
      audience: '',
      jwkUrl: ''
    };

    onChange({
      ...config,
      proxyAuth: {
        ...config.proxyAuth,
        jwtProviders: [...(config.proxyAuth?.jwtProviders || []), newProvider]
      }
    });
  };

  const updateJwtProvider = (index, field, value) => {
    const providers = [...(config.proxyAuth?.jwtProviders || [])];
    providers[index] = { ...providers[index], [field]: value };

    onChange({
      ...config,
      proxyAuth: {
        ...config.proxyAuth,
        jwtProviders: providers
      }
    });
  };

  const removeJwtProvider = index => {
    const providers = [...(config.proxyAuth?.jwtProviders || [])];
    providers.splice(index, 1);

    onChange({
      ...config,
      proxyAuth: {
        ...config.proxyAuth,
        jwtProviders: providers
      }
    });
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div>
          <h4 className="text-md font-medium text-gray-900 dark:text-gray-100">
            {t('admin.auth.jwtProviders', 'JWT Providers')}
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Configure JWT token validation for pure JWT authentication (no headers required)
          </p>
        </div>
        <button
          type="button"
          onClick={addJwtProvider}
          className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-blue-700 bg-blue-100 hover:bg-blue-200"
        >
          <Icon name="plus" size="sm" className="mr-1" />
          Add Provider
        </button>
      </div>
      {(config.proxyAuth?.jwtProviders || []).map((provider, index) => (
        <div key={index} className="p-4 border border-gray-200 rounded-md mb-4">
          <div className="flex justify-between items-start mb-3">
            <h5 className="font-medium text-gray-900">JWT Provider {index + 1}</h5>
            <button
              type="button"
              onClick={() => removeJwtProvider(index)}
              className="text-red-600 hover:text-red-800"
            >
              <Icon name="trash" size="sm" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="Provider name"
              value={provider.name || ''}
              onChange={e => updateJwtProvider(index, 'name', e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            />
            <input
              type="text"
              placeholder="Header name"
              value={provider.header || ''}
              onChange={e => updateJwtProvider(index, 'header', e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            />
            <input
              type="text"
              placeholder="Issuer URL"
              value={provider.issuer || ''}
              onChange={e => updateJwtProvider(index, 'issuer', e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            />
            <input
              type="text"
              placeholder="Audience"
              value={provider.audience || ''}
              onChange={e => updateJwtProvider(index, 'audience', e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            />
            <input
              type="text"
              placeholder="JWK URL"
              value={provider.jwkUrl || ''}
              onChange={e => updateJwtProvider(index, 'jwkUrl', e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm md:col-span-2"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default JwtProvidersSection;
