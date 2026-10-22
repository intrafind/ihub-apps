// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { fetchPlatformConfig } from '../../../api';

const SIGNED_OUT = Object.freeze({ persistence: false, resolving: false });
const RESOLVING = Object.freeze({ persistence: false, resolving: true });
const STORED = Object.freeze({ persistence: true, resolving: false });
const NOT_STORED = Object.freeze({ persistence: false, resolving: false });

/**
 * Whether the task pane's chats are kept in the chat history. Every chat is
 * stored server-side; without the history each one is temporary.
 *
 * The web app answers this with `useChatPersistence()`, which reads the auth and
 * platform-config contexts the pane does not have: the pane signs in with its
 * own token. The question is the same one, though — `chats.persistence` on the
 * public platform config, resolved server-side from the feature flag, the
 * platform switch and a storage provider that came up — and a signed-in pane
 * user is never anonymous, so that flag is the whole answer here.
 *
 * `resolving` is true until the config has been read for this sign-in, from
 * the very render the user signs in on. A chat surface has to wait it out: it
 * decides whether a new chat is kept or temporary, and whether the history is
 * offered.
 *
 * A failed read answers "no history": every chat is then temporary.
 *
 * @param {boolean} signedIn - Whether the pane has a signed-in user.
 * @returns {{ persistence: boolean, resolving: boolean }}
 */
export default function useOfficeChatPersistence(signedIn) {
  // The answer for the current sign-in; null until it has been read. Reset on
  // sign-out, so the next sign-in starts out resolving rather than reusing it.
  const [stored, setStored] = useState(null);

  useEffect(() => {
    if (!signedIn) {
      setStored(null);
      return undefined;
    }
    let live = true;
    fetchPlatformConfig()
      .then(config => {
        if (live) setStored(config?.chats?.persistence === true);
      })
      .catch(() => {
        if (live) setStored(false);
      });
    return () => {
      live = false;
    };
  }, [signedIn]);

  if (!signedIn) return SIGNED_OUT;
  if (stored === null) return RESOLVING;
  return stored ? STORED : NOT_STORED;
}
