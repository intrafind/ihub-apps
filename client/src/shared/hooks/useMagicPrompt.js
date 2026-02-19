import { useState } from 'react';
import { generateMagicPrompt } from '../../api/api';
import { FeatureFlags } from '../../../../shared/featureFlags.js';

/**
 * Custom hook for magic prompt generation functionality.
 * Transforms user input into enhanced prompts using AI.
 * @returns {Object} Magic prompt utilities
 * @returns {string|null} returns.originalInput - Original user input before transformation
 * @returns {boolean} returns.magicLoading - Whether generation is in progress
 * @returns {Function} returns.handleMagicPrompt - Generate a magic prompt from input (input, app, appId) => Promise<string|null>
 * @returns {Function} returns.handleUndoMagicPrompt - Restore the original input () => string|null
 * @returns {Function} returns.resetMagicPrompt - Reset magic prompt state () => void
 * @returns {boolean} returns.showUndoMagicPrompt - Whether undo option should be shown
 */
export const useMagicPrompt = () => {
  const [originalInput, setOriginalInput] = useState(null);
  const [magicLoading, setMagicLoading] = useState(false);

  const handleMagicPrompt = async (input, app, appId) => {
    if (!input.trim()) return;

    try {
      setMagicLoading(true);

      // Use FeatureFlags utility to get nested feature values
      const featureFlags = new FeatureFlags();
      const response = await generateMagicPrompt(input, {
        prompt: featureFlags.getAppFeatureValue(app, 'magicPrompt.prompt', null),
        modelId: featureFlags.getAppFeatureValue(app, 'magicPrompt.model', null),
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
