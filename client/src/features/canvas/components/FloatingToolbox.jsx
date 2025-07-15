import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

const FloatingToolbox = ({ onAction, isProcessing, hasSelection, editorContent }) => {
  const { t } = useTranslation();
  const noSelectionActions = ['continue', 'summarize', 'outline'];
  const [expandedSection, setExpandedSection] = useState(null);
  const toolboxRef = useRef(null);
  const timeoutRef = useRef(null);

  const toolSections = [
    {
      id: 'ai-writing',
      icon: 'sparkles',
      label: t('canvas.toolbox.aiWriting', 'AI Writing'),
      color: 'text-purple-600',
      bgColor: 'bg-purple-50 hover:bg-purple-100',
      tools: [
        {
          id: 'continue',
          icon: 'arrow-right',
          label: t('canvas.continue', 'Continue writing'),
          description: 'Continue writing from where you left off'
        },
        {
          id: 'summarize',
          icon: 'document-text',
          label: t('canvas.summarize', 'Summarize'),
          description: 'Summarize the current document'
        },
        {
          id: 'outline',
          icon: 'list',
          label: t('canvas.outline', 'Create outline'),
          description: 'Create an outline of the content'
        }
      ]
    },
    {
      id: 'text-editing',
      icon: 'pencil',
      label: t('canvas.toolbox.textEditing', 'Text Editing'),
      color: 'text-blue-600',
      bgColor: 'bg-blue-50 hover:bg-blue-100',
      tools: [
        {
          id: 'expand',
          icon: 'plus-circle',
          label: t('canvas.expand', 'Expand'),
          description: 'Make text longer and more detailed'
        },
        {
          id: 'condense',
          icon: 'minus-circle',
          label: t('canvas.condense', 'Condense'),
          description: 'Make text shorter and more concise'
        },
        {
          id: 'paraphrase',
          icon: 'refresh',
          label: t('canvas.paraphrase', 'Paraphrase'),
          description: 'Rewrite with different words'
        },
        {
          id: 'clarify',
          icon: 'light-bulb',
          label: t('canvas.clarify', 'Clarify'),
          description: 'Make text clearer and easier to understand'
        }
      ]
    },
    {
      id: 'tone-style',
      icon: 'color-swatch',
      label: t('canvas.toolbox.toneStyle', 'Tone & Style'),
      color: 'text-green-600',
      bgColor: 'bg-green-50 hover:bg-green-100',
      tools: [
        {
          id: 'formal',
          icon: 'academic-cap',
          label: t('canvas.formal', 'Formal'),
          description: 'Make text more formal and professional'
        },
        {
          id: 'casual',
          icon: 'chat',
          label: t('canvas.casual', 'Casual'),
          description: 'Make text more casual and friendly'
        },
        {
          id: 'professional',
          icon: 'briefcase',
          label: t('canvas.professional', 'Professional'),
          description: 'Make text more professional'
        },
        {
          id: 'creative',
          icon: 'paint-brush',
          label: t('canvas.creative', 'Creative'),
          description: 'Make text more creative and engaging'
        }
      ]
    },
    {
      id: 'utilities',
      icon: 'cog',
      label: t('canvas.toolbox.utilities', 'Utilities'),
      color: 'text-gray-600',
      bgColor: 'bg-gray-50 hover:bg-gray-100',
      tools: [
        {
          id: 'translate',
          icon: 'globe',
          label: t('canvas.translate', 'Translate'),
          description: 'Translate text to another language'
        },
        {
          id: 'grammar',
          icon: 'check-circle',
          label: t('canvas.grammar', 'Grammar'),
          description: 'Check and fix grammar'
        },
        {
          id: 'format',
          icon: 'format',
          label: t('canvas.format', 'Format'),
          description: 'Format and structure text'
        }
      ]
    }
  ];

  const handleSectionToggle = sectionId => {
    setExpandedSection(expandedSection === sectionId ? null : sectionId);
  };

  const handleToolAction = (toolId, description) => {
    // Clear any pending timeouts
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // Safety check for onAction prop
    if (typeof onAction === 'function') {
      onAction(toolId, description);
    }
    setExpandedSection(null);
  };

  // Close expanded section when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (toolboxRef.current && !toolboxRef.current.contains(event.target)) {
        setExpandedSection(null);
      }
    };

    if (expandedSection) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [expandedSection]);

  // Auto-close expanded section after delay
  useEffect(() => {
    if (expandedSection) {
      timeoutRef.current = setTimeout(() => {
        setExpandedSection(null);
      }, 10000); // Auto close after 10 seconds

      return () => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
      };
    }
  }, [expandedSection]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={toolboxRef}
      className="floating-toolbox fixed right-4 top-1/2 transform -translate-y-1/2 z-40 bg-white rounded-2xl shadow-lg border border-gray-200"
    >
      <div className="p-2 space-y-1">
        {toolSections.map(section => (
          <div key={section.id} className="relative">
            {/* Section Button */}
            <button
              onClick={() => handleSectionToggle(section.id)}
              disabled={isProcessing}
              className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-200 ${
                expandedSection === section.id
                  ? section.bgColor.replace('hover:', '')
                  : 'bg-gray-50 hover:bg-gray-100'
              } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
              title={section.label}
            >
              <Icon
                name={section.icon}
                size="sm"
                className={expandedSection === section.id ? section.color : 'text-gray-600'}
              />
            </button>

            {/* Expanded Tools */}
            {expandedSection === section.id && (
              <div className="absolute right-full top-0 mr-2 bg-white rounded-xl shadow-xl border border-gray-200 p-2 min-w-48 z-50">
                <div className="mb-2 px-2 py-1 border-b border-gray-100">
                  <h4 className="text-sm font-medium text-gray-800">{section.label}</h4>
                </div>
                <div className="space-y-1">
                  {section.tools.map(tool => (
                    <button
                      key={tool.id}
                      onClick={() => handleToolAction(tool.id, tool.description)}
                      disabled={
                        isProcessing || (!hasSelection && !noSelectionActions.includes(tool.id))
                      }
                      className="w-full flex items-center gap-2 px-2 py-2 text-sm rounded-lg bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title={tool.description}
                    >
                      <Icon name={tool.icon} size="sm" className="text-gray-600" />
                      <span className="text-left text-gray-700">{tool.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default FloatingToolbox;
