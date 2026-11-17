// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import SecretRevealDialog from '../../../shared/components/SecretRevealDialog';
import { clearSecretReveal, useSecretReveal } from '../state/secretReveal';

/**
 * Shows a one-time secret put in the secret-reveal store, whichever admin page
 * is open. Mounted once by the admin layout so a result that arrives after its
 * page was left is still shown.
 */
export default function AdminSecretRevealHost() {
  const reveal = useSecretReveal();
  return (
    <SecretRevealDialog
      isOpen={Boolean(reveal)}
      title={reveal?.title || ''}
      description={reveal?.description}
      fieldLabel={reveal?.fieldLabel}
      secret={reveal?.secret || ''}
      onDone={clearSecretReveal}
    />
  );
}
