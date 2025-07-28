import { useState } from 'react';
import { generateMagicPrompt } from '../../api/api';

export const useMagicPrompt = () => {
  const [originalInput, setOriginalInput] = useState(null);
  const [magicLoading, setMagicLoading] = useState(false);

  const handleMagicPrompt = async (input, app, appId) => {
    if (!input.trim()) return;

    try {
      setMagicLoading(true);
      const response = await generateMagicPrompt(input, {
        prompt: app?.features?.magicPrompt?.prompt,
        modelId: app?.features?.magicPrompt?.model,
        appId
      });

      if (response && response.prompt) {
        setOriginalInput(input);
        return response.prompt;
      }

      return null;
    } catch (err) {
      console.error('Error generating magic prompt:', err);
      return null;
    } finally {
      setMagicLoading(false);
    }
  };

  const handleUndoMagicPrompt = () => {
    if (originalInput !== null) {
      const restored = originalInput;
      setOriginalInput(null);
      return restored;
    }
    return null;
  };

  const resetMagicPrompt = () => {
    setOriginalInput(null);
    setMagicLoading(false);
  };

  return {
    originalInput,
    magicLoading,
    handleMagicPrompt,
    handleUndoMagicPrompt,
    resetMagicPrompt,
    showUndoMagicPrompt: originalInput !== null
  };
};

export default useMagicPrompt;
