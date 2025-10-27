import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { fetchToolsBasic } from '../../../api';
import { DEFAULT_LANGUAGE } from '../../../utils/localizeContent';
import { buildApiUrl } from '../../../utils/runtimeBasePath';

const AppCreationWizard = ({ onClose, templateApp = null }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // FIXME - we should remove this and instead just use verification if the collected informations are correct
  const [appData, setAppData] = useState({
    id: '',
    name: { en: '' },
    description: { en: '' },
    color: '#4F46E5',
    icon: 'chat-bubbles',
    system: { en: '' },
    tokenLimit: 4096,
    preferredModel: 'gpt-4',
    preferredOutputFormat: 'markdown',
    preferredStyle: 'normal',
    preferredTemperature: 0.7,
    enabled: true,
    order: 0,
    messagePlaceholder: { en: '' },
    prompt: { en: '{{content}}' },
    variables: [],
    starterPrompts: [],
    tools: [],
    allowEmptyContent: false,
    sendChatHistory: true,
    category: 'utility',
    features: {
      magicPrompt: {
        enabled: false,
        model: 'gpt-4',
        prompt:
          'You are a helpful assistant that improves user prompts to be more specific and effective. Improve this prompt: {{prompt}}'
      }
    },
    settings: {
      enabled: true,
      model: { enabled: true },
      temperature: { enabled: true },
      outputFormat: { enabled: true },
      chatHistory: { enabled: true },
      style: { enabled: true }
    },
    inputMode: {
      type: 'singleline',
      microphone: {
        enabled: false
      }
    },
    imageUpload: {
      enabled: false
    },
    // Creation method flags
    useAI: false,
    useTemplate: false,
    useManual: false,
    // Inheritance tracking
    parentId: templateApp?.id || null,
    inheritanceLevel: templateApp ? (templateApp.inheritanceLevel || 0) + 1 : 0,
    overriddenFields: []
  });

  // Wizard steps configuration
  const steps = [
    {
      id: 'method',
      title: t('admin.apps.wizard.method.title', 'Creation Method'),
      description: t(
        'admin.apps.wizard.method.description',
        'How would you like to create your app?'
      ),
      component: CreationMethodStep
    },
    {
      id: 'ai-generation',
      title: t('admin.apps.wizard.ai.title', 'AI Generation'),
      description: t('admin.apps.wizard.ai.description', 'Describe what your app should do'),
      component: AIGenerationStep,
      skip: () => !appData.useAI
    },
    {
      id: 'basic-info',
      title: t('admin.apps.wizard.basic.title', 'Basic Information'),
      description: t(
        'admin.apps.wizard.basic.description',
        'Configure name, description, and appearance'
      ),
      component: BasicInfoStep
    },
    {
      id: 'system-prompt',
      title: t('admin.apps.wizard.system.title', 'System Instructions'),
      description: t('admin.apps.wizard.system.description', 'Define how your app should behave'),
      component: SystemPromptStep
    },
    {
      id: 'variables',
      title: t('admin.apps.wizard.variables.title', 'Variables'),
      description: t('admin.apps.wizard.variables.description', 'Add user-configurable variables'),
      component: VariablesStep
    },
    {
      id: 'tools',
      title: t('admin.apps.wizard.tools.title', 'Tools'),
      description: t('admin.apps.wizard.tools.description', 'Select available tools'),
      component: ToolsStep
    },
    {
      id: 'advanced',
      title: t('admin.apps.wizard.advanced.title', 'Advanced Settings'),
      description: t('admin.apps.wizard.advanced.description', 'Configure advanced features'),
      component: AdvancedSettingsStep
    },
    {
      id: 'review',
      title: t('admin.apps.wizard.review.title', 'Review & Create'),
      description: t('admin.apps.wizard.review.description', 'Review your app configuration'),
      component: ReviewStep
    }
  ];

  // Initialize with template data if provided
  useEffect(() => {
    if (templateApp) {
      setAppData(prev => ({
        ...prev,
        ...templateApp,
        id: '', // Clear ID for new app
        parentId: templateApp.id,
        inheritanceLevel: (templateApp.inheritanceLevel || 0) + 1,
        overriddenFields: []
      }));
    }
  }, [templateApp]);

  const getVisibleSteps = () => {
    return steps.filter(step => !step.skip || !step.skip());
  };

  const validateCurrentStep = () => {
    const currentStepData = getVisibleSteps()[currentStep];
    const missingFields = [];

    switch (currentStepData.id) {
      case 'method':
        if (!appData.useAI && !appData.useTemplate && !appData.useManual) {
          missingFields.push('creationMethod');
        }
        break;
      case 'ai-generation':
        // AI generation is optional, no validation needed
        break;
      case 'basic-info':
        if (!appData.id || !appData.id.trim()) {
          missingFields.push('id');
        }
        if (!appData.name || !Object.values(appData.name).some(v => v && v.trim())) {
          missingFields.push('name');
        }
        if (!appData.description || !Object.values(appData.description).some(v => v && v.trim())) {
          missingFields.push('description');
        }
        break;
      case 'system-prompt':
        if (!appData.system || !Object.values(appData.system).some(v => v && v.trim())) {
          missingFields.push('system');
        }
        break;
      // Variables and tools are optional
      case 'variables':
      case 'tools':
      case 'advanced':
        break;
      case 'review':
        // Final validation
        if (!appData.id || !appData.id.trim()) missingFields.push('id');
        if (!appData.name || !Object.values(appData.name).some(v => v && v.trim()))
          missingFields.push('name');
        if (!appData.description || !Object.values(appData.description).some(v => v && v.trim()))
          missingFields.push('description');
        if (!appData.system || !Object.values(appData.system).some(v => v && v.trim()))
          missingFields.push('system');
        break;
    }

    return missingFields;
  };

  const handleNext = async () => {
    const visibleSteps = getVisibleSteps();

    if (currentStep < visibleSteps.length - 1) {
      // Validate current step before proceeding
      const missingFields = validateCurrentStep();
      if (missingFields.length > 0) {
        setError(
          t(
            'admin.apps.wizard.error.missingFields',
            'Please fill in all required fields before proceeding.'
          )
        );
        return;
      }

      setError(null);
      setCurrentStep(currentStep + 1);
    } else {
      // Final step - create the app
      await handleCreateApp();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleFinishApp = () => {
    // Jump to the review step
    const visibleSteps = getVisibleSteps();
    const reviewStepIndex = visibleSteps.findIndex(step => step.id === 'review');
    if (reviewStepIndex !== -1) {
      setCurrentStep(reviewStepIndex);
    }
  };

  const handleCreateApp = async () => {
    try {
      setLoading(true);
      setError(null);

      // Validate required fields based on schema
      const requiredFields = {
        id: t('admin.apps.wizard.error.idRequired', 'App ID is required'),
        name: t('admin.apps.wizard.error.nameRequired', 'App name is required'),
        description: t(
          'admin.apps.wizard.error.descriptionRequired',
          'App description is required'
        ),
        color: t('admin.apps.wizard.error.colorRequired', 'App color is required'),
        icon: t('admin.apps.wizard.error.iconRequired', 'App icon is required'),
        system: t('admin.apps.wizard.error.systemRequired', 'System instructions are required'),
        tokenLimit: t('admin.apps.wizard.error.tokenLimitRequired', 'Token limit is required')
      };

      // Check required fields
      for (const [field, errorMessage] of Object.entries(requiredFields)) {
        if (!appData[field]) {
          setError(errorMessage);
          return;
        }
        // For multilingual fields, ensure at least one language has content
        if (typeof appData[field] === 'object' && !Array.isArray(appData[field])) {
          const hasContent = Object.values(appData[field]).some(value => value && value.trim());
          if (!hasContent) {
            setError(errorMessage);
            return;
          }
        }
      }

      // Clean up the app data - remove empty strings for optional fields
      const cleanedAppData = { ...appData };

      // Remove empty multilingual fields
      ['messagePlaceholder', 'prompt'].forEach(field => {
        if (cleanedAppData[field]) {
          const cleaned = {};
          Object.entries(cleanedAppData[field]).forEach(([lang, value]) => {
            if (value && value.trim()) {
              cleaned[lang] = value;
            }
          });
          if (Object.keys(cleaned).length === 0) {
            delete cleanedAppData[field];
          } else {
            cleanedAppData[field] = cleaned;
          }
        }
      });

      // Create the app
      const response = await makeAdminApiCall('admin/apps', {
        method: 'POST',
        body: JSON.stringify(cleanedAppData)
      });

      if (response.ok) {
        onClose();
        navigate('/admin/apps');
      } else {
        const errorData = await response.json();
        setError(
          errorData.error || t('admin.apps.wizard.error.createFailed', 'Failed to create app')
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const updateAppData = updates => {
    setAppData(prev => {
      const newData = { ...prev, ...updates };

      // Track overridden fields for inheritance
      if (templateApp) {
        const overriddenFields = [];
        Object.keys(updates).forEach(key => {
          if (JSON.stringify(templateApp[key]) !== JSON.stringify(newData[key])) {
            overriddenFields.push(key);
          }
        });
        newData.overriddenFields = [...(prev.overriddenFields || []), ...overriddenFields];
      }

      return newData;
    });
  };

  const revertToParent = fieldName => {
    if (templateApp && templateApp[fieldName] !== undefined) {
      setAppData(prev => ({
        ...prev,
        [fieldName]: templateApp[fieldName],
        overriddenFields: prev.overriddenFields.filter(f => f !== fieldName)
      }));
    }
  };

  const visibleSteps = getVisibleSteps();
  const currentStepData = visibleSteps[currentStep];
  const CurrentStepComponent = currentStepData.component;

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-8 mx-auto p-5 border w-11/12 max-w-4xl shadow-lg rounded-md bg-white max-h-[90vh] flex flex-col">
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">
                {t('admin.apps.wizard.title', 'Create New App')}
                {templateApp && (
                  <span className="ml-2 text-sm text-gray-500">
                    {t('admin.apps.wizard.basedOn', 'Based on')} "{templateApp.name.en}"
                  </span>
                )}
              </h3>
              <p className="mt-1 text-sm text-gray-600">{currentStepData.description}</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <Icon name="x" className="h-6 w-6" />
            </button>
          </div>

          {/* Progress indicator */}
          <div className="py-4">
            <div className="flex items-center justify-between">
              {visibleSteps.map((step, index) => (
                <div
                  key={step.id}
                  className={`flex items-center ${index < visibleSteps.length - 1 ? 'flex-1' : ''}`}
                >
                  <button
                    onClick={() => index <= currentStep && setCurrentStep(index)}
                    className={`flex items-center justify-center w-8 h-8 rounded-full border-2 ${
                      index === currentStep
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : index < currentStep
                          ? 'bg-green-600 border-green-600 text-white hover:bg-green-700'
                          : 'border-gray-300 text-gray-400'
                    } ${index <= currentStep ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                    disabled={index > currentStep}
                  >
                    {index < currentStep ? (
                      <Icon name="check" className="h-4 w-4" />
                    ) : (
                      <span className="text-sm font-medium">{index + 1}</span>
                    )}
                  </button>
                  {index < visibleSteps.length - 1 && (
                    <div
                      className={`flex-1 h-0.5 mx-2 ${
                        index < currentStep ? 'bg-green-600' : 'bg-gray-300'
                      }`}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Current step content */}
          <div className="flex-1 overflow-y-auto">
            <h4 className="text-lg font-medium text-gray-900 mb-4">{currentStepData.title}</h4>

            {error && (
              <div className="mb-4 bg-red-50 border border-red-200 rounded-md p-4">
                <div className="flex">
                  <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
                  <div className="ml-3">
                    <p className="text-sm text-red-800">{error}</p>
                  </div>
                </div>
              </div>
            )}

            <CurrentStepComponent
              appData={appData}
              updateAppData={updateAppData}
              templateApp={templateApp}
              revertToParent={revertToParent}
              validateCurrentStep={validateCurrentStep}
              error={error}
            />
          </div>

          {/* Navigation buttons */}
          <div className="flex justify-between pt-4 border-t mt-4">
            <button
              onClick={handleBack}
              disabled={currentStep === 0}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('admin.apps.wizard.back', 'Back')}
            </button>

            <div className="flex space-x-2">
              {/* Show Finish App button from step 3 onwards */}
              {currentStep >= 2 && currentStep < visibleSteps.length - 1 && (
                <button
                  onClick={handleFinishApp}
                  className="px-4 py-2 text-sm font-medium text-white bg-green-600 border border-transparent rounded-md hover:bg-green-700"
                >
                  {t('admin.apps.wizard.finish', 'Finish App')}
                </button>
              )}

              <button
                onClick={handleNext}
                disabled={loading}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 border border-transparent rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <span className="flex items-center">
                    <Icon name="refresh" className="animate-spin -ml-1 mr-2 h-4 w-4" />
                    {t('admin.apps.wizard.creating', 'Creating...')}
                  </span>
                ) : currentStep === visibleSteps.length - 1 ? (
                  t('admin.apps.wizard.create', 'Create App')
                ) : (
                  t('admin.apps.wizard.next', 'Next')
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Step 1: Creation Method
const CreationMethodStep = ({
  appData,
  updateAppData,
  templateApp,
  validateCurrentStep,
  error
}) => {
  const { t } = useTranslation();
  const [fieldErrors, setFieldErrors] = useState({});

  // Check for validation errors
  useEffect(() => {
    if (error && error.includes('required fields')) {
      const missingFields = validateCurrentStep();
      const newFieldErrors = {};
      missingFields.forEach(field => {
        newFieldErrors[field] = true;
      });
      setFieldErrors(newFieldErrors);
    }
  }, [error, validateCurrentStep]);

  const handleMethodChange = method => {
    if (method === 'ai') {
      updateAppData({ useAI: true, useTemplate: false, useManual: false });
    } else if (method === 'template') {
      updateAppData({ useAI: false, useTemplate: true, useManual: false });
    } else if (method === 'manual') {
      updateAppData({ useAI: false, useTemplate: false, useManual: true });
    }

    // Clear field error when user makes selection
    if (fieldErrors.creationMethod) {
      setFieldErrors(prev => ({ ...prev, creationMethod: false }));
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-sm text-gray-600 mb-4">
        {t('admin.apps.wizard.method.instruction', 'Choose how you want to create your app:')}
      </div>

      {fieldErrors.creationMethod && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <p className="text-sm text-red-800">
                {t('admin.apps.wizard.error.methodRequired', 'Please select a creation method')}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        <label
          className={`relative flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50 ${fieldErrors.creationMethod ? 'border-red-300' : ''}`}
        >
          <input
            type="radio"
            name="creationMethod"
            value="ai"
            checked={appData.useAI === true}
            onChange={() => handleMethodChange('ai')}
            className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300"
          />
          <div className="ml-3 flex-1">
            <div className="flex items-center">
              <Icon name="sparkles" className="h-5 w-5 text-purple-500 mr-2" />
              <span className="text-sm font-medium text-gray-900">
                {t('admin.apps.wizard.method.ai', 'AI-Generated')}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1">
              {t(
                'admin.apps.wizard.method.aiDescription',
                'Describe what your app should do, and AI will generate the configuration for you.'
              )}
            </p>
          </div>
        </label>

        <label
          className={`relative flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50 ${fieldErrors.creationMethod ? 'border-red-300' : ''}`}
        >
          <input
            type="radio"
            name="creationMethod"
            value="manual"
            checked={appData.useManual === true}
            onChange={() => handleMethodChange('manual')}
            className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300"
          />
          <div className="ml-3 flex-1">
            <div className="flex items-center">
              <Icon name="cog" className="h-5 w-5 text-blue-500 mr-2" />
              <span className="text-sm font-medium text-gray-900">
                {t('admin.apps.wizard.method.manual', 'Manual Configuration')}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1">
              {t(
                'admin.apps.wizard.method.manualDescription',
                'Configure your app step by step with full control over all settings.'
              )}
            </p>
          </div>
        </label>

        {templateApp && (
          <label
            className={`relative flex items-start p-4 border rounded-lg cursor-pointer hover:bg-gray-50 ${fieldErrors.creationMethod ? 'border-red-300' : ''}`}
          >
            <input
              type="radio"
              name="creationMethod"
              value="template"
              checked={appData.useTemplate === true}
              onChange={() => handleMethodChange('template')}
              className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300"
            />
            <div className="ml-3 flex-1">
              <div className="flex items-center">
                <Icon name="cog" className="h-5 w-5 text-green-500 mr-2" />
                <span className="text-sm font-medium text-gray-900">
                  {t('admin.apps.wizard.method.template', 'Based on Template')}
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                {t(
                  'admin.apps.wizard.method.templateDescription',
                  'Start with the configuration from "{templateName}" and customize it.',
                  { templateName: templateApp.name.en }
                )}
              </p>
            </div>
          </label>
        )}
      </div>
    </div>
  );
};

// Step 2: AI Generation
const AIGenerationStep = ({ appData, updateAppData }) => {
  const { t, i18n } = useTranslation();
  const [generating, setGenerating] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState(null);
  const [appGeneratorPrompt, setAppGeneratorPrompt] = useState(null);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState(i18n.language || 'en');

  // Load the app generator prompt from configuration
  useEffect(() => {
    const loadAppGeneratorPrompt = async () => {
      try {
        setLoadingPrompt(true);
        const response = await makeAdminApiCall(
          buildApiUrl(`admin/prompts/app-generator?lang=${selectedLanguage}`)
        );
        if (response.ok) {
          const data = await response.json();
          setAppGeneratorPrompt(data);
        } else {
          console.error('Failed to load app generator prompt');
          // Fallback to default language if the selected language fails
          if (selectedLanguage !== DEFAULT_LANGUAGE) {
            const fallbackResponse = await makeAdminApiCall(
              buildApiUrl(`admin/prompts/app-generator?lang=${DEFAULT_LANGUAGE}`)
            );
            if (fallbackResponse.ok) {
              const fallbackData = await fallbackResponse.json();
              setAppGeneratorPrompt(fallbackData);
            }
          }
        }
      } catch (err) {
        console.error('Error loading app generator prompt:', err);
      } finally {
        setLoadingPrompt(false);
      }
    };

    loadAppGeneratorPrompt();
  }, [selectedLanguage]);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;

    try {
      setGenerating(true);

      // Use OpenAI completion directly for app generation
      const response = await makeAdminApiCall('completions', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: appGeneratorPrompt.prompt
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          responseFormat: 'json',
          responseSchema: appGeneratorPrompt.outputSchema,
          temperature: 1.0
        })
      });

      if (response.ok) {
        const data = await response.json();
        console.log('AI generation result:', JSON.stringify(data, null, 2));
        const generatedConfig = data.choices[0].message.content;

        // Parse the generated JSON configuration
        try {
          let configJson;

          // Prefer direct JSON when structured output is enabled
          try {
            configJson = JSON.parse(generatedConfig);
          } catch {
            const jsonMatch = generatedConfig.match(/```json\s*(\{[\s\S]*?\})\s*```/);
            if (jsonMatch) {
              configJson = JSON.parse(jsonMatch[1]);
            }
          }

          if (configJson) {
            // Convert to multilingual format and merge with existing app data
            const multilingualConfig = {
              // Keep existing app data structure
              ...appData,

              // Apply generated config
              id: configJson.id || appData.id,
              name:
                typeof configJson.name === 'string'
                  ? { [selectedLanguage]: configJson.name }
                  : configJson.name,
              description:
                typeof configJson.description === 'string'
                  ? { [selectedLanguage]: configJson.description }
                  : configJson.description,
              system:
                typeof configJson.system === 'string'
                  ? { [selectedLanguage]: configJson.system }
                  : configJson.system,
              category: configJson.category || appData.category,
              color: configJson.color || appData.color,
              icon: configJson.icon || appData.icon,
              variables: configJson.variables || appData.variables,
              tools: configJson.tools || appData.tools,

              // Mark as AI generated
              aiGenerated: true,
              aiPrompt: prompt,
              useAI: true
            };

            console.log('Generated config:', configJson);
            console.log('Multilingual config:', multilingualConfig);

            updateAppData(multilingualConfig);
          } else {
            console.error('No valid JSON found in generated config');
            setError(
              t('admin.apps.wizard.ai.error.parse', 'Failed to parse generated configuration')
            );
          }
        } catch (e) {
          console.error('Failed to parse generated config:', e);
          setError(
            t('admin.apps.wizard.ai.error.parse', 'Failed to parse generated configuration')
          );
        }
      } else {
        // Enhanced error handling - try to get the error message from the response
        try {
          const errorData = await response.json();
          const errorMessage =
            errorData.error || errorData.message || 'Failed to generate app configuration';
          setError(errorMessage);
        } catch {
          setError(
            t('admin.apps.wizard.ai.error.generate', 'Failed to generate app configuration')
          );
        }
      }
    } catch (error) {
      console.error('Failed to generate app:', error);
      setError(
        t('admin.apps.wizard.ai.error.network', 'Network error occurred while generating app')
      );
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {t('admin.apps.wizard.ai.language', 'Language')}
        </label>
        <select
          value={selectedLanguage}
          onChange={e => setSelectedLanguage(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
        >
          <option value="en">English</option>
          <option value="de">Deutsch</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {t('admin.apps.wizard.ai.prompt', 'Describe your app')}
        </label>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={4}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          placeholder={t(
            'admin.apps.wizard.ai.promptPlaceholder',
            'Example: Create a meeting summarizer app that takes meeting notes and extracts key points, action items, and decisions...'
          )}
          disabled={loadingPrompt}
        />
        {loadingPrompt && (
          <p className="mt-1 text-sm text-gray-500">
            {t('admin.apps.wizard.ai.loadingPrompt', 'Loading prompt configuration...')}
          </p>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={handleGenerate}
        disabled={!prompt.trim() || generating || loadingPrompt || !appGeneratorPrompt}
        className="w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {generating ? (
          <>
            <Icon name="refresh" className="animate-spin -ml-1 mr-2 h-4 w-4" />
            {t('admin.apps.wizard.ai.generating', 'Generating...')}
          </>
        ) : (
          <>
            <Icon name="sparkles" className="-ml-1 mr-2 h-4 w-4" />
            {t('admin.apps.wizard.ai.generate', 'Generate App')}
          </>
        )}
      </button>

      {appData.aiGenerated && (
        <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-md">
          <div className="flex">
            <Icon name="check-circle" className="h-5 w-5 text-green-400" />
            <div className="ml-3">
              <p className="text-sm text-green-800">
                {t(
                  'admin.apps.wizard.ai.success',
                  'App configuration generated successfully! You can review and modify it in the next steps.'
                )}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Step 3: Basic Information
const BasicInfoStep = ({
  appData,
  updateAppData,
  templateApp,
  revertToParent,
  validateCurrentStep,
  error
}) => {
  const { t, i18n } = useTranslation();
  const [selectedLanguage, setSelectedLanguage] = useState(i18n.language || 'en');
  const [fieldErrors, setFieldErrors] = useState({});

  const isOverridden = field => {
    return templateApp && appData.overriddenFields?.includes(field);
  };

  const updateMultilingualField = (field, value) => {
    const currentValue = appData[field] || {};
    updateAppData({
      [field]: {
        ...currentValue,
        [selectedLanguage]: value
      }
    });

    // Clear field error when user starts typing
    if (fieldErrors[field]) {
      setFieldErrors(prev => ({ ...prev, [field]: false }));
    }
  };

  const updateField = (field, value) => {
    updateAppData({ [field]: value });

    // Clear field error when user starts typing
    if (fieldErrors[field]) {
      setFieldErrors(prev => ({ ...prev, [field]: false }));
    }
  };

  const getMultilingualValue = field => {
    const currentValue = appData[field] || {};
    return currentValue[selectedLanguage] || '';
  };

  // Check for validation errors and highlight fields
  useEffect(() => {
    if (error && error.includes('required fields')) {
      const missingFields = validateCurrentStep();
      const newFieldErrors = {};
      missingFields.forEach(field => {
        newFieldErrors[field] = true;
      });
      setFieldErrors(newFieldErrors);
    }
  }, [error, validateCurrentStep]);

  const getFieldClassName = field => {
    const baseClass =
      'mt-1 block w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500';
    if (fieldErrors[field]) {
      return `${baseClass} border-red-300 focus:border-red-500`;
    }
    return `${baseClass} border-gray-300 focus:border-indigo-500`;
  };

  return (
    <div className="space-y-6">
      {/* Language Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700">
          {t('admin.apps.wizard.basic.language', 'Language')}
        </label>
        <select
          value={selectedLanguage}
          onChange={e => setSelectedLanguage(e.target.value)}
          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
        >
          <option value="en">English</option>
          <option value="de">Deutsch</option>
          <option value="fr">Français</option>
          <option value="es">Español</option>
          <option value="it">Italiano</option>
          <option value="pt">Português</option>
          <option value="ru">Русский</option>
          <option value="zh">中文</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
        </select>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-gray-700">
            {t('admin.apps.wizard.basic.appId', 'App ID')} <span className="text-red-500">*</span>
          </label>
          {isOverridden('id') && (
            <button
              onClick={() => revertToParent('id')}
              className="text-xs text-indigo-600 hover:text-indigo-500"
            >
              {t('admin.apps.wizard.revert', 'Revert to parent')}
            </button>
          )}
        </div>
        <input
          type="text"
          value={appData.id}
          onChange={e => updateField('id', e.target.value)}
          className={getFieldClassName('id')}
          placeholder={t('admin.apps.wizard.basic.appIdPlaceholder', 'e.g., my-awesome-app')}
          required
        />
        {fieldErrors.id && (
          <p className="mt-1 text-sm text-red-600">
            {t('admin.apps.wizard.error.idRequired', 'App ID is required')}
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-gray-700">
            {t('admin.apps.wizard.basic.name', 'App Name')} <span className="text-red-500">*</span>
          </label>
          {isOverridden('name') && (
            <button
              onClick={() => revertToParent('name')}
              className="text-xs text-indigo-600 hover:text-indigo-500"
            >
              {t('admin.apps.wizard.revert', 'Revert to parent')}
            </button>
          )}
        </div>
        <input
          type="text"
          value={getMultilingualValue('name')}
          onChange={e => updateMultilingualField('name', e.target.value)}
          className={getFieldClassName('name')}
          placeholder={t('admin.apps.wizard.basic.namePlaceholder', 'Enter app name')}
          required
        />
        {fieldErrors.name && (
          <p className="mt-1 text-sm text-red-600">
            {t('admin.apps.wizard.error.nameRequired', 'App name is required')}
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-gray-700">
            {t('admin.apps.wizard.basic.description', 'Description')}{' '}
            <span className="text-red-500">*</span>
          </label>
          {isOverridden('description') && (
            <button
              onClick={() => revertToParent('description')}
              className="text-xs text-indigo-600 hover:text-indigo-500"
            >
              {t('admin.apps.wizard.revert', 'Revert to parent')}
            </button>
          )}
        </div>
        <textarea
          value={getMultilingualValue('description')}
          onChange={e => updateMultilingualField('description', e.target.value)}
          rows={3}
          className={getFieldClassName('description')}
          placeholder={t('admin.apps.wizard.basic.descriptionPlaceholder', 'Enter app description')}
          required
        />
        {fieldErrors.description && (
          <p className="mt-1 text-sm text-red-600">
            {t('admin.apps.wizard.error.descriptionRequired', 'App description is required')}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700">
              {t('admin.apps.wizard.basic.color', 'Color')}
            </label>
            {isOverridden('color') && (
              <button
                onClick={() => revertToParent('color')}
                className="text-xs text-indigo-600 hover:text-indigo-500"
              >
                {t('admin.apps.wizard.revert', 'Revert to parent')}
              </button>
            )}
          </div>
          <input
            type="color"
            value={appData.color}
            onChange={e => updateField('color', e.target.value)}
            className="mt-1 block w-full h-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700">
              {t('admin.apps.wizard.basic.icon', 'Icon')}
            </label>
            {isOverridden('icon') && (
              <button
                onClick={() => revertToParent('icon')}
                className="text-xs text-indigo-600 hover:text-indigo-500"
              >
                {t('admin.apps.wizard.revert', 'Revert to parent')}
              </button>
            )}
          </div>
          <input
            type="text"
            value={appData.icon}
            onChange={e => updateField('icon', e.target.value)}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder={t('admin.apps.wizard.basic.iconPlaceholder', 'e.g., chat-bubbles')}
          />
        </div>
      </div>
    </div>
  );
};

// Step 4: System Prompt
const SystemPromptStep = ({
  appData,
  updateAppData,
  templateApp,
  revertToParent,
  validateCurrentStep,
  error
}) => {
  const { t, i18n } = useTranslation();
  const [selectedLanguage, setSelectedLanguage] = useState(i18n.language || 'en');
  const [fieldErrors, setFieldErrors] = useState({});

  const isOverridden = field => {
    return templateApp && appData.overriddenFields?.includes(field);
  };

  const updateMultilingualField = (field, value) => {
    const currentValue = appData[field] || {};
    updateAppData({
      [field]: {
        ...currentValue,
        [selectedLanguage]: value
      }
    });

    // Clear field error when user starts typing
    if (fieldErrors[field]) {
      setFieldErrors(prev => ({ ...prev, [field]: false }));
    }
  };

  const getMultilingualValue = field => {
    const currentValue = appData[field] || {};
    return currentValue[selectedLanguage] || '';
  };

  // Check for validation errors and highlight fields
  useEffect(() => {
    if (error && error.includes('required fields')) {
      const missingFields = validateCurrentStep();
      const newFieldErrors = {};
      missingFields.forEach(field => {
        newFieldErrors[field] = true;
      });
      setFieldErrors(newFieldErrors);
    }
  }, [error, validateCurrentStep]);

  const getFieldClassName = field => {
    const baseClass =
      'mt-1 block w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500';
    if (fieldErrors[field]) {
      return `${baseClass} border-red-300 focus:border-red-500`;
    }
    return `${baseClass} border-gray-300 focus:border-indigo-500`;
  };

  return (
    <div className="space-y-6">
      {/* Language Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700">
          {t('admin.apps.wizard.basic.language', 'Language')}
        </label>
        <select
          value={selectedLanguage}
          onChange={e => setSelectedLanguage(e.target.value)}
          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
        >
          <option value="en">English</option>
          <option value="de">Deutsch</option>
          <option value="fr">Français</option>
          <option value="es">Español</option>
          <option value="it">Italiano</option>
          <option value="pt">Português</option>
          <option value="ru">Русский</option>
          <option value="zh">中文</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
        </select>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-gray-700">
            {t('admin.apps.wizard.system.prompt', 'System Instructions')}{' '}
            <span className="text-red-500">*</span>
          </label>
          {isOverridden('system') && (
            <button
              onClick={() => revertToParent('system')}
              className="text-xs text-indigo-600 hover:text-indigo-500"
            >
              {t('admin.apps.wizard.revert', 'Revert to parent')}
            </button>
          )}
        </div>
        <textarea
          value={getMultilingualValue('system')}
          onChange={e => updateMultilingualField('system', e.target.value)}
          rows={6}
          className={getFieldClassName('system')}
          placeholder={t(
            'admin.apps.wizard.system.promptPlaceholder',
            'Enter system instructions that define how the AI should behave...'
          )}
          required
        />
        {fieldErrors.system && (
          <p className="mt-1 text-sm text-red-600">
            {t('admin.apps.wizard.error.systemRequired', 'System instructions are required')}
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-gray-700">
            {t('admin.apps.wizard.system.messagePlaceholder', 'Message Placeholder')}
          </label>
          {isOverridden('messagePlaceholder') && (
            <button
              onClick={() => revertToParent('messagePlaceholder')}
              className="text-xs text-indigo-600 hover:text-indigo-500"
            >
              {t('admin.apps.wizard.revert', 'Revert to parent')}
            </button>
          )}
        </div>
        <input
          type="text"
          value={getMultilingualValue('messagePlaceholder')}
          onChange={e => updateMultilingualField('messagePlaceholder', e.target.value)}
          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          placeholder={t(
            'admin.apps.wizard.system.messagePlaceholderPlaceholder',
            'Enter your message here...'
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            {t('admin.apps.wizard.system.model', 'Preferred Model')}
          </label>
          <select
            value={appData.preferredModel}
            onChange={e => updateAppData({ preferredModel: e.target.value })}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="gpt-4">GPT-4</option>
            <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
            <option value="claude-3-opus-20240229">Claude 3 Opus</option>
            <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            {t('admin.apps.wizard.system.temperature', 'Temperature')}
          </label>
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={appData.preferredTemperature}
            onChange={e => updateAppData({ preferredTemperature: parseFloat(e.target.value) })}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>
      </div>
    </div>
  );
};

// Step 5: Variables
const VariablesStep = ({ appData, updateAppData }) => {
  const { t } = useTranslation();

  const addVariable = () => {
    const newVariable = {
      name: '',
      label: { en: '' },
      type: 'string',
      required: false,
      defaultValue: { en: '' },
      predefinedValues: []
    };
    updateAppData({ variables: [...(appData.variables || []), newVariable] });
  };

  const removeVariable = index => {
    const newVariables = appData.variables.filter((_, i) => i !== index);
    updateAppData({ variables: newVariables });
  };

  const updateVariable = (index, field, value) => {
    const newVariables = [...appData.variables];
    newVariables[index] = { ...newVariables[index], [field]: value };
    updateAppData({ variables: newVariables });
  };

  return (
    <div className="space-y-6">
      <div className="text-sm text-gray-600">
        {t(
          'admin.apps.wizard.variables.instruction',
          'Variables allow users to customize the app behavior. They can be used in the prompt template with {{variableName}} syntax.'
        )}
      </div>

      <div className="space-y-4">
        {appData.variables?.map((variable, index) => (
          <div key={index} className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h5 className="text-sm font-medium text-gray-900">
                {t('admin.apps.wizard.variables.variable', 'Variable {{index}}', {
                  index: index + 1
                })}
              </h5>
              <button
                onClick={() => removeVariable(index)}
                className="text-red-600 hover:text-red-700"
              >
                <Icon name="trash" className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t('admin.apps.wizard.variables.name', 'Name')}
                </label>
                <input
                  type="text"
                  value={variable.name}
                  onChange={e => updateVariable(index, 'name', e.target.value)}
                  className="block w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  placeholder={t(
                    'admin.apps.wizard.variables.namePlaceholder',
                    'e.g., targetLanguage'
                  )}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t('admin.apps.wizard.variables.type', 'Type')}
                </label>
                <select
                  value={variable.type}
                  onChange={e => updateVariable(index, 'type', e.target.value)}
                  className="block w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="string">String</option>
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                </select>
              </div>
            </div>

            <div className="mt-3">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t('admin.apps.wizard.variables.label', 'Label')}
              </label>
              <input
                type="text"
                value={variable.label.en}
                onChange={e =>
                  updateVariable(index, 'label', { ...variable.label, en: e.target.value })
                }
                className="block w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                placeholder={t(
                  'admin.apps.wizard.variables.labelPlaceholder',
                  'e.g., Target Language'
                )}
              />
            </div>

            <div className="mt-3 flex items-center">
              <input
                type="checkbox"
                checked={variable.required}
                onChange={e => updateVariable(index, 'required', e.target.checked)}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900">
                {t('admin.apps.wizard.variables.required', 'Required')}
              </label>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={addVariable}
        className="w-full flex items-center justify-center px-4 py-2 border border-dashed border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        <Icon name="plus" className="h-4 w-4 mr-2" />
        {t('admin.apps.wizard.variables.add', 'Add Variable')}
      </button>
    </div>
  );
};

// Step 6: Tools
const ToolsStep = ({ appData, updateAppData }) => {
  const { t } = useTranslation();
  const [availableTools, setAvailableTools] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    // Load available tools
    const loadTools = async () => {
      try {
        const tools = await fetchToolsBasic();
        setAvailableTools(tools);
      } catch (error) {
        console.error('Failed to load tools:', error);
      }
    };
    loadTools();
  }, []);

  const toggleTool = toolId => {
    const currentTools = appData.tools || [];
    const isSelected = currentTools.includes(toolId);

    if (isSelected) {
      updateAppData({ tools: currentTools.filter(id => id !== toolId) });
    } else {
      updateAppData({ tools: [...currentTools, toolId] });
    }
  };

  const filteredTools = availableTools.filter(
    tool =>
      tool.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tool.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="text-sm text-gray-600">
        {t(
          'admin.apps.wizard.tools.instruction',
          'Select the tools that will be available to your app. Tools extend the capabilities of the AI assistant.'
        )}
      </div>

      {/* Search input */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <Icon name="search" className="h-5 w-5 text-gray-400" />
        </div>
        <input
          type="text"
          placeholder={t('admin.apps.wizard.tools.searchPlaceholder', 'Search tools...')}
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          autoComplete="off"
        />
        {searchTerm && (
          <button
            onClick={() => setSearchTerm('')}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
            aria-label={t('common.clearSearch', 'Clear search')}
          >
            <Icon name="x" className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="space-y-3 max-h-96 overflow-y-auto">
        {filteredTools.map(tool => (
          <label
            key={tool.id}
            className="flex items-start p-3 border rounded-lg cursor-pointer hover:bg-gray-50"
          >
            <input
              type="checkbox"
              checked={appData.tools?.includes(tool.id) || false}
              onChange={() => toggleTool(tool.id)}
              className="mt-1 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
            />
            <div className="ml-3 flex-1">
              <div className="text-sm font-medium text-gray-900">{tool.name}</div>
              <div className="text-sm text-gray-500">{tool.description}</div>
            </div>
          </label>
        ))}
      </div>

      {availableTools.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <Icon name="cog" className="h-8 w-8 mx-auto mb-2" />
          <p>{t('admin.apps.wizard.tools.noTools', 'No tools available')}</p>
        </div>
      )}

      {filteredTools.length === 0 && availableTools.length > 0 && (
        <div className="text-center py-8 text-gray-500">
          <Icon name="search" className="h-8 w-8 mx-auto mb-2" />
          <p>{t('admin.apps.wizard.tools.noResults', 'No tools match your search')}</p>
        </div>
      )}
    </div>
  );
};

// Step 7: Advanced Settings
const AdvancedSettingsStep = ({ appData, updateAppData }) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="text-sm text-gray-600">
        {t('admin.apps.wizard.advanced.instruction', 'Configure advanced settings for your app.')}
      </div>

      <div className="space-y-4">
        <div className="flex items-center">
          <input
            type="checkbox"
            checked={appData.allowEmptyContent}
            onChange={e => updateAppData({ allowEmptyContent: e.target.checked })}
            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
          />
          <label className="ml-2 block text-sm text-gray-900">
            {t('admin.apps.wizard.advanced.allowEmptyContent', 'Allow Empty Content')}
          </label>
        </div>

        <div className="flex items-center">
          <input
            type="checkbox"
            checked={appData.sendChatHistory}
            onChange={e => updateAppData({ sendChatHistory: e.target.checked })}
            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
          />
          <label className="ml-2 block text-sm text-gray-900">
            {t('admin.apps.wizard.advanced.sendChatHistory', 'Send Chat History')}
          </label>
        </div>

        <div className="flex items-center">
          <input
            type="checkbox"
            checked={appData.imageUpload?.enabled}
            onChange={e =>
              updateAppData({ imageUpload: { ...appData.imageUpload, enabled: e.target.checked } })
            }
            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
          />
          <label className="ml-2 block text-sm text-gray-900">
            {t('admin.apps.wizard.advanced.imageUpload', 'Enable Image Upload')}
          </label>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('admin.apps.wizard.advanced.category', 'Category')}
          </label>
          <select
            value={appData.category || ''}
            onChange={e => updateAppData({ category: e.target.value })}
            className="block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="">Select category...</option>
            <option value="productivity">Productivity</option>
            <option value="creativity">Creativity</option>
            <option value="communication">Communication</option>
            <option value="analysis">Analysis</option>
            <option value="utility">Utility</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('admin.apps.wizard.advanced.order', 'Display Order')}
          </label>
          <input
            type="number"
            value={appData.order || 0}
            onChange={e => updateAppData({ order: parseInt(e.target.value) || 0 })}
            className="block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>
      </div>
    </div>
  );
};

// Step 8: Review
const ReviewStep = ({ appData, templateApp }) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="text-sm text-gray-600">
        {t(
          'admin.apps.wizard.review.instruction',
          'Review your app configuration before creating it.'
        )}
      </div>

      <div className="bg-gray-50 rounded-lg p-4">
        <div className="space-y-3">
          <div className="flex items-center">
            <div
              className="h-8 w-8 rounded-full flex items-center justify-center text-white font-bold mr-3"
              style={{ backgroundColor: appData.color }}
            >
              {appData.name.en.charAt(0).toUpperCase()}
            </div>
            <div>
              <h3 className="font-medium text-gray-900">{appData.name.en}</h3>
              <p className="text-sm text-gray-600">{appData.description.en}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">ID:</span> {appData.id}
            </div>
            <div>
              <span className="text-gray-500">Model:</span> {appData.preferredModel}
            </div>
            <div>
              <span className="text-gray-500">Variables:</span> {appData.variables?.length || 0}
            </div>
            <div>
              <span className="text-gray-500">Tools:</span> {appData.tools?.length || 0}
            </div>
          </div>

          {templateApp && (
            <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
              <div className="flex items-center">
                <Icon name="information-circle" className="h-4 w-4 text-blue-400 mr-2" />
                <span className="text-sm text-blue-800">
                  {t('admin.apps.wizard.review.basedOn', 'Based on template: {templateName}', {
                    templateName: templateApp.name.en
                  })}
                </span>
              </div>
              {appData.overriddenFields?.length > 0 && (
                <div className="mt-2 text-xs text-blue-700">
                  {t('admin.apps.wizard.review.overridden', 'Overridden fields: {fields}', {
                    fields: appData.overriddenFields.join(', ')
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4">
        <div className="flex">
          <Icon name="exclamation-triangle" className="h-5 w-5 text-yellow-400" />
          <div className="ml-3">
            <p className="text-sm text-yellow-800">
              {t(
                'admin.apps.wizard.review.warning',
                'Once created, you can edit the app configuration but cannot change its ID. Make sure the ID is unique and descriptive.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AppCreationWizard;
