import { forwardRef, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ComparePanel from './ComparePanel';

/**
 * Side-by-side comparison view.
 *
 * Renders N identical ComparePanel instances (currently two) and forwards an
 * aggregate imperative API to the parent:
 *   - sendMessage(messageStructure) — broadcast to every panel
 *   - clearAll()                    — reset every panel
 *   - cancelAll()                   — cancel any in-flight generation
 *
 * Per-panel state (model selection, chat instance, message handlers) lives
 * inside each ComparePanel — this layout never thinks in "left/right" terms.
 */
const CompareModeView = forwardRef(function CompareModeView(
  {
    app,
    appId,
    models,
    currentLanguage,
    outputFormat,
    sendChatHistory,
    onPanelProcessingChange,
    onMessageComplete,
    onOpenInCanvas,
    canvasEnabled,
    requiredIntegrations,
    onConnectIntegration,
    onClarificationSubmit,
    onClarificationSkip,
    onDocumentAction
  },
  ref
) {
  const { t } = useTranslation();

  // Default each panel to a different model when possible.
  const defaultModels = [models[0]?.id ?? null, models[1]?.id ?? models[0]?.id ?? null];

  const panelConfigs = [
    {
      key: 'panel-a',
      label: t('chat.compareMode.modelA', 'Model A'),
      accentColorClass: 'bg-blue-500'
    },
    {
      key: 'panel-b',
      label: t('chat.compareMode.modelB', 'Model B'),
      accentColorClass: 'bg-green-500'
    }
  ];

  const panelHandlesRef = useRef(panelConfigs.map(() => null));

  const forEachPanel = fn => {
    panelHandlesRef.current.forEach(panel => {
      if (panel) fn(panel);
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      sendMessage(messageStructure) {
        forEachPanel(panel => panel.sendMessage(messageStructure));
      },
      clearAll() {
        forEachPanel(panel => panel.clear());
      },
      cancelAll() {
        forEachPanel(panel => panel.cancel());
      }
    }),
    []
  );

  return (
    <div className="flex flex-col md:flex-row gap-4 h-full min-h-0 overflow-hidden divide-y md:divide-y-0 md:divide-x divide-gray-200 dark:divide-gray-700">
      {panelConfigs.map((config, index) => (
        <ComparePanel
          key={config.key}
          ref={el => {
            panelHandlesRef.current[index] = el;
          }}
          label={config.label}
          accentColorClass={config.accentColorClass}
          app={app}
          appId={appId}
          models={models}
          defaultModelId={defaultModels[index]}
          currentLanguage={currentLanguage}
          outputFormat={outputFormat}
          sendChatHistory={sendChatHistory}
          onProcessingChange={value => onPanelProcessingChange?.(index, value)}
          onMessageComplete={onMessageComplete}
          onOpenInCanvas={onOpenInCanvas}
          canvasEnabled={canvasEnabled}
          requiredIntegrations={requiredIntegrations}
          onConnectIntegration={onConnectIntegration}
          onClarificationSubmit={onClarificationSubmit}
          onClarificationSkip={onClarificationSkip}
          onDocumentAction={onDocumentAction}
        />
      ))}
    </div>
  );
});

export default CompareModeView;
