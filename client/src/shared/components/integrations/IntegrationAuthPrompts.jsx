import IntegrationConnectionCard from './IntegrationConnectionCard';

/**
 * Component that displays authentication prompts for required integrations
 */
const IntegrationAuthPrompts = ({ requiredIntegrations = [], onConnect, className = '' }) => {
  if (!requiredIntegrations.length) return null;

  return (
    <div className={`integration-auth-prompts ${className}`}>
      {requiredIntegrations.map(({ id, config, state }) => (
        <IntegrationConnectionCard
          key={id}
          integration={id}
          config={config}
          state={state}
          onConnect={onConnect}
        />
      ))}
    </div>
  );
};

export default IntegrationAuthPrompts;
