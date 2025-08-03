import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useCodeBlockInteractions } from '../../hooks/useCodeBlockInteractions';
import { useMermaidRenderer } from '../../hooks/useMermaidRenderer';
import { configureMarked } from '../../config/marked.config';

// Re-export configureMarked for backward compatibility
export { configureMarked };

const MarkdownRenderer = () => {
  const { t } = useTranslation();
  
  // Custom hook for copy/download buttons on standard code blocks
  useCodeBlockInteractions();
  
  // Custom hook for all Mermaid-related logic
  useMermaidRenderer({ t });

  useEffect(() => {
    // Configure marked once on component mount, passing the translation function
    configureMarked(t);
  }, [t]);

  // This component's purpose is to set up global listeners and configurations.
  // It doesn't render any visible elements itself.
  return null;
};

export default MarkdownRenderer;