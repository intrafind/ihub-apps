import { Component } from 'react';
import { useNetworkStatus } from '../contexts/NetworkStatusContext';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';

class ConnectionErrorBoundaryClass extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Connection error boundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback(this.state.error, () =>
        this.setState({ hasError: false, error: null })
      );
    }

    return this.props.children;
  }
}

// Wrapper component to access hooks
const ConnectionErrorBoundary = ({ children, fallback }) => {
  const { getErrorMessage, retryConnection, isRetrying } = useNetworkStatus();
  const { t } = useTranslation();

  const defaultFallback = (error, retry) => (
    <div className="flex flex-col items-center justify-center min-h-64 p-8 text-center">
      <Icon name="exclamation-triangle" className="w-12 h-12 text-orange-500 mb-4" />
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
        {t('error.connection.title', 'Connection Problem')}
      </h3>
      <p className="text-gray-600 dark:text-gray-400 mb-6 max-w-md">{getErrorMessage(error, t)}</p>
      <div className="flex space-x-3">
        <button
          onClick={() => {
            retry();
            retryConnection();
          }}
          disabled={isRetrying}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-4 py-2 rounded-lg font-medium transition-colors duration-200 flex items-center space-x-2"
        >
          {isRetrying && <Icon name="refresh" className="w-4 h-4 animate-spin" />}
          <span>
            {isRetrying
              ? t('error.connection.retrying', 'Retrying...')
              : t('error.connection.retry', 'Try Again')}
          </span>
        </button>
        <button
          onClick={() => window.location.reload()}
          className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded-lg font-medium transition-colors duration-200"
        >
          {t('error.connection.refresh', 'Refresh Page')}
        </button>
      </div>
    </div>
  );

  return (
    <ConnectionErrorBoundaryClass fallback={fallback || defaultFallback}>
      {children}
    </ConnectionErrorBoundaryClass>
  );
};

export default ConnectionErrorBoundary;
