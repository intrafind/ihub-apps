import { Component } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import Icon from './Icon';

// Error boundary wrapper component
class ErrorBoundaryComponent extends Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Log the error to an error reporting service
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({ errorInfo });

    // You could send this to an error tracking service like Sentry here
    // if (typeof window.reportError === 'function') {
    //   window.reportError(error, errorInfo);
    // }
  }

  render() {
    if (this.state.hasError) {
      // Render error UI
      return (
        <ErrorFallback
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          resetErrorBoundary={() => {
            this.setState({ hasError: false, error: null, errorInfo: null });
          }}
        />
      );
    }

    return this.props.children;
  }
}

// Error fallback display component with reset capability and translation
const ErrorFallback = ({ error, resetErrorBoundary }) => {
  const { t } = useTranslation();

  if (error?.status === 401) {
    return <Navigate to="/unauthorized" replace />;
  }
  if (error?.status === 403) {
    return <Navigate to="/forbidden" replace />;
  }
  if (error?.status >= 500) {
    return <Navigate to="/server-error" replace />;
  }

  return (
    <div role="alert" className="p-4 m-4 bg-red-50 border border-red-200 rounded-md">
      <div className="flex items-center mb-4">
        <Icon name="exclamation-triangle" size="lg" className="text-red-500 mr-2" />
        <h2 className="text-xl font-bold text-red-700">
          {t('error.title', 'Something went wrong')}
        </h2>
      </div>

      <div className="mb-4">
        <p className="text-gray-700 mb-2">
          {t(
            'error.description',
            'An unexpected error occurred in the application. The development team has been notified.'
          )}
        </p>
        <p className="text-gray-500 text-sm mb-1">{t('error.errorMessage', 'Error details:')}</p>
        <div className="bg-gray-100 p-2 rounded overflow-auto max-h-32 text-xs font-mono text-gray-800">
          {error && error.toString()}
        </div>
      </div>

      <div className="flex flex-col space-y-2">
        <button
          onClick={resetErrorBoundary}
          className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded transition-colors"
        >
          {t('error.tryAgain', 'Try Again')}
        </button>

        <button
          onClick={() => (window.location.href = '/')}
          className="border border-indigo-600 text-indigo-600 hover:bg-indigo-50 py-2 px-4 rounded transition-colors"
        >
          {t('error.backToHome', 'Back to Home')}
        </button>
      </div>
    </div>
  );
};

// Higher-order component creator for easier use
const withErrorBoundary = WrappedComponent => {
  return props => (
    <ErrorBoundaryComponent>
      <WrappedComponent {...props} />
    </ErrorBoundaryComponent>
  );
};

// Main ErrorBoundary component for export
const ErrorBoundary = ({ children }) => {
  return <ErrorBoundaryComponent>{children}</ErrorBoundaryComponent>;
};

export default ErrorBoundary;
export { withErrorBoundary };
