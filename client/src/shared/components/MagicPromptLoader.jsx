import React from 'react';
import Icon from './Icon';
import './MagicPrompt.css';

const MagicPromptLoader = () => {
  return (
    <div className="magic-prompt-stars">
      <Icon name="star" size="xs" className="magic-prompt-star" />
      <Icon name="star" size="xs" className="magic-prompt-star" />
      <Icon name="star" size="xs" className="magic-prompt-star" />
    </div>
  );
};

export default MagicPromptLoader;
