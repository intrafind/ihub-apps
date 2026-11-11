// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useContext } from 'react';

/**
 * The context object and hook of the AI-use acknowledgement gate, apart from the
 * provider, so a component that only asks the gate does not import the provider's
 * dependencies (the dialog, the UI config, the API).
 */
const AiAcknowledgementContext = createContext(null);

/**
 * The acknowledgement gate, or `null` outside the provider (an embedded host,
 * a test): the caller then simply does not gate and the server decides.
 */
export function useAiAcknowledgement() {
  return useContext(AiAcknowledgementContext);
}

export default AiAcknowledgementContext;
