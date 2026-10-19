// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import Icon from './Icon';
import './MagicPrompt.css';

export default function MagicPromptLoader() {
  return (
    <div className="magic-prompt-stars">
      <Icon name="star" size="xs" className="magic-prompt-star" />
      <Icon name="star" size="xs" className="magic-prompt-star" />
      <Icon name="star" size="xs" className="magic-prompt-star" />
    </div>
  );
}
