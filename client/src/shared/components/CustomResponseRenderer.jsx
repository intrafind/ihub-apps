import { useState, useEffect, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

// Registry of available custom renderers
// Add new renderers here as they are created
const RENDERER_REGISTRY = {
  NDAResultsRenderer: () => import('./renderers/NDAResultsRenderer')
};

/**
 * CustomResponseRenderer - Renders custom response components for structured app outputs
 *
 * This component dynamically loads and renders custom React components
 * to display structured JSON responses in a user-friendly format.
 *
 * @param {string} componentName - Name of the renderer component
 * @param {object} data - Parsed JSON data to pass to the component
 * @param {string} className - Optional CSS classes for the container
 */
const CustomResponseRenderer = ({ componentName, data, className = '' }) => {
  const [RendererComponent, setRendererComponent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { t } = useTranslation();

  useEffect(() => {
    const loadComponent = async () => {
      try {
        setLoading(true);
        setError(null);

        // Check if renderer exists in registry
        const rendererLoader = RENDERER_REGISTRY[componentName];
        if (!rendererLoader) {
          throw new Error(`Renderer "${componentName}" not found in registry`);
        }

        // Dynamically import the component
        const module = await rendererLoader();
        const Component = module.default;

        if (!Component) {
          throw new Error(`No default export found in renderer "${componentName}"`);
        }

        setRendererComponent(() => Component);
      } catch (err) {
        console.error('Error loading custom response renderer:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    if (componentName) {
      loadComponent();
    }
  }, [componentName]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-3 text-gray-600">{t('common.loading', 'Loading...')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border-2 border-red-200 rounded-lg p-6 bg-red-50">
        <div className="flex items-center mb-4">
          <svg
            className="w-6 h-6 text-red-600 mr-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h3 className="text-red-800 font-semibold">
            {t('errors.rendererError', 'Renderer Error')}
          </h3>
        </div>
        <p className="text-sm text-red-700">{error}</p>
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-red-600 hover:text-red-800">
            {t('common.details', 'Details')}
          </summary>
          <pre className="text-xs text-red-700 bg-red-100 p-3 rounded mt-2 overflow-auto">
            Component: {componentName}
            {'\n'}
            Available renderers: {Object.keys(RENDERER_REGISTRY).join(', ')}
            {'\n'}
            Data: {JSON.stringify(data, null, 2)}
          </pre>
        </details>
      </div>
    );
  }

  if (!RendererComponent) {
    return (
      <div className="text-center py-8 text-gray-500">
        {t('errors.noComponentFound', 'No component found')}
      </div>
    );
  }

  // Render the component with data and translation function
  return (
    <div className={className}>
      <Suspense
        fallback={
          <div className="flex items-center justify-center p-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        }
      >
        <RendererComponent data={data} t={t} />
      </Suspense>
    </div>
  );
};

export default CustomResponseRenderer;
