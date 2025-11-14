import { useState } from 'react';

/**
 * NDAResultsRenderer - Custom renderer for NDA Risk Analysis JSON output
 * Displays risk assessment results in a user-friendly, color-coded format
 */
const NDAResultsRenderer = ({ data, t }) => {
  // Helper function to get risk color classes
  const getRiskColorClasses = level => {
    switch (level?.toLowerCase()) {
      case 'red':
        return {
          container: 'bg-red-50 border-red-300',
          border: 'border-l-red-500',
          text: 'text-red-900',
          badge: 'bg-red-100 text-red-800 border-red-300',
          icon: 'text-red-500'
        };
      case 'yellow':
        return {
          container: 'bg-yellow-50 border-yellow-300',
          border: 'border-l-yellow-500',
          text: 'text-yellow-900',
          badge: 'bg-yellow-100 text-yellow-800 border-yellow-300',
          icon: 'text-yellow-500'
        };
      case 'green':
        return {
          container: 'bg-green-50 border-green-300',
          border: 'border-l-green-500',
          text: 'text-green-900',
          badge: 'bg-green-100 text-green-800 border-green-300',
          icon: 'text-green-500'
        };
      default:
        return {
          container: 'bg-gray-50 border-gray-300',
          border: 'border-l-gray-500',
          text: 'text-gray-900',
          badge: 'bg-gray-100 text-gray-800 border-gray-300',
          icon: 'text-gray-500'
        };
    }
  };

  // Helper function to get risk icon
  const getRiskIcon = level => {
    switch (level?.toLowerCase()) {
      case 'red':
        return (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clipRule="evenodd"
            />
          </svg>
        );
      case 'yellow':
        return (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        );
      case 'green':
        return (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
        );
      default:
        return null;
    }
  };

  // Get risk level label
  const getRiskLabel = level => {
    const labels = {
      red: t ? t('nda.risk.high', 'High Risk') : 'High Risk',
      yellow: t ? t('nda.risk.medium', 'Medium Risk') : 'Medium Risk',
      green: t ? t('nda.risk.low', 'Low Risk') : 'Low Risk'
    };
    return labels[level?.toLowerCase()] || level;
  };

  if (!data || !data.clauses) {
    return (
      <div className="p-4 text-center text-gray-500">
        {t ? t('nda.noData', 'No analysis data available') : 'No analysis data available'}
      </div>
    );
  }

  const overallColors = getRiskColorClasses(data.overall_risk);

  return (
    <div className="space-y-6 p-4">
      {/* Overall Risk Summary */}
      <div
        className={`rounded-lg border-2 ${overallColors.container} ${overallColors.border} border-l-8 p-6 shadow-sm`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className={overallColors.icon}>{getRiskIcon(data.overall_risk)}</div>
            <div>
              <h2 className={`text-2xl font-bold ${overallColors.text}`}>
                {t ? t('nda.overallRisk', 'Overall Risk Assessment') : 'Overall Risk Assessment'}
              </h2>
              <span
                className={`inline-block mt-2 px-4 py-1 rounded-full text-sm font-semibold border ${overallColors.badge}`}
              >
                {getRiskLabel(data.overall_risk)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Summary Statistics */}
      <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
        <h4 className="text-sm font-semibold text-gray-700 mb-3">
          {t ? t('nda.summary', 'Summary') : 'Summary'}
        </h4>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-red-600">
              {data.clauses.filter(c => c.risk_level?.toLowerCase() === 'red').length}
            </div>
            <div className="text-xs text-gray-600 mt-1">
              {t ? t('nda.highRiskItems', 'High Risk') : 'High Risk'}
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold text-yellow-600">
              {data.clauses.filter(c => c.risk_level?.toLowerCase() === 'yellow').length}
            </div>
            <div className="text-xs text-gray-600 mt-1">
              {t ? t('nda.mediumRiskItems', 'Medium Risk') : 'Medium Risk'}
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold text-green-600">
              {data.clauses.filter(c => c.risk_level?.toLowerCase() === 'green').length}
            </div>
            <div className="text-xs text-gray-600 mt-1">
              {t ? t('nda.lowRiskItems', 'Low Risk') : 'Low Risk'}
            </div>
          </div>
        </div>
      </div>

      {/* Clause Analysis Cards */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-gray-700 mb-4">
          {t ? t('nda.detailedAnalysis', 'Detailed Analysis') : 'Detailed Analysis'}
        </h3>

        {data.clauses.map((clause, idx) => {
          return <ClauseCard key={idx} clause={clause} t={t} />;
        })}
      </div>
    </div>
  );
};

// Separate component for each clause card (to manage its own state)
const ClauseCard = ({ clause, t }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const getRiskColorClasses = level => {
    switch (level?.toLowerCase()) {
      case 'red':
        return {
          container: 'bg-red-50 border-red-300',
          border: 'border-l-red-500',
          text: 'text-red-900',
          badge: 'bg-red-100 text-red-800 border-red-300',
          icon: 'text-red-500'
        };
      case 'yellow':
        return {
          container: 'bg-yellow-50 border-yellow-300',
          border: 'border-l-yellow-500',
          text: 'text-yellow-900',
          badge: 'bg-yellow-100 text-yellow-800 border-yellow-300',
          icon: 'text-yellow-500'
        };
      case 'green':
        return {
          container: 'bg-green-50 border-green-300',
          border: 'border-l-green-500',
          text: 'text-green-900',
          badge: 'bg-green-100 text-green-800 border-green-300',
          icon: 'text-green-500'
        };
      default:
        return {
          container: 'bg-gray-50 border-gray-300',
          border: 'border-l-gray-500',
          text: 'text-gray-900',
          badge: 'bg-gray-100 text-gray-800 border-gray-300',
          icon: 'text-gray-500'
        };
    }
  };

  const getRiskIcon = level => {
    switch (level?.toLowerCase()) {
      case 'red':
        return (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clipRule="evenodd"
            />
          </svg>
        );
      case 'yellow':
        return (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        );
      case 'green':
        return (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
        );
      default:
        return null;
    }
  };

  const getRiskLabel = level => {
    const labels = {
      red: t ? t('nda.risk.high', 'High Risk') : 'High Risk',
      yellow: t ? t('nda.risk.medium', 'Medium Risk') : 'Medium Risk',
      green: t ? t('nda.risk.low', 'Low Risk') : 'Low Risk'
    };
    return labels[level?.toLowerCase()] || level;
  };

  const colors = getRiskColorClasses(clause.risk_level);

  return (
    <div
      className={`rounded-lg border ${colors.container} ${colors.border} border-l-4 shadow-sm transition-all duration-200 hover:shadow-md`}
    >
      <div className="p-4">
        {/* Clause Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center space-x-3 flex-1">
            <div className={colors.icon}>{getRiskIcon(clause.risk_level)}</div>
            <div className="flex-1">
              <h4 className={`text-lg font-semibold ${colors.text}`}>{clause.clause_name}</h4>
              <span
                className={`inline-block mt-1 px-3 py-0.5 rounded-full text-xs font-medium border ${colors.badge}`}
              >
                {getRiskLabel(clause.risk_level)}
              </span>
            </div>
          </div>
        </div>

        {/* Reason */}
        <div className={`mb-3 p-3 rounded bg-white bg-opacity-50 ${colors.text}`}>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{clause.reason}</p>
        </div>

        {/* Citations (Expandable) */}
        {clause.citation && clause.citation.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className={`flex items-center space-x-2 text-sm font-medium ${colors.text} hover:underline focus:outline-none`}
            >
              <svg
                className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              <span>
                {isExpanded
                  ? t
                    ? t('nda.hideCitations', 'Hide Citations')
                    : 'Hide Citations'
                  : t
                    ? t('nda.showCitations', 'Show Citations ({count})').replace(
                        '{count}',
                        clause.citation.length
                      )
                    : `Show Citations (${clause.citation.length})`}
              </span>
            </button>

            {isExpanded && (
              <div className="mt-3 space-y-2">
                {clause.citation.map((cite, citIdx) => (
                  <div
                    key={citIdx}
                    className={`p-3 rounded border-l-2 bg-white bg-opacity-70 ${colors.border} text-sm italic ${colors.text}`}
                  >
                    <span className="text-xs font-semibold not-italic opacity-60">
                      {t ? t('nda.citation', 'Citation') : 'Citation'} {citIdx + 1}:
                    </span>
                    <p className="mt-1 leading-relaxed whitespace-pre-wrap">&quot;{cite}&quot;</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default NDAResultsRenderer;
