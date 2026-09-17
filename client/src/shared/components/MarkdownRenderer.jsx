import { useTranslation } from 'react-i18next';
import { useCodeBlockInteractions } from '../../hooks/useCodeBlockInteractions';
import { useMermaidRenderer } from '../../hooks/useMermaidRenderer';

function MarkdownRenderer() {
  const { t } = useTranslation();

  // Custom hook for copy/download buttons on standard code blocks
  useCodeBlockInteractions();

  // Custom hook for all Mermaid-related logic
  useMermaidRenderer({ t });

  // This component's purpose is to set up global listeners and configurations.
  // It doesn't render any visible elements itself.
  return null;
}

export default MarkdownRenderer;
