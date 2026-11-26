// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Read one chat artifact on behalf of a user, to copy it somewhere else:
 * into a project ("Copy to project") or into another chat as a file
 * ("Use in app").
 *
 * An artifact is reachable the same two ways it is readable in the UI:
 *
 *  - `{ chatId, artifactId }`: a chat the user may read (`authorizeChat`
 *    with intent `read`: their own, a chat of a project they are a member
 *    of, or any chat for an admin).
 *  - `{ shareId, artifactId }`: a chat or a file shared with the user, and
 *    only an artifact the share names (its allow-list), exactly as the share
 *    page reads it.
 *
 * Every refusal is a 404, as for any other read of a chat the caller cannot
 * see: whether the chat or the artifact exists is not revealed.
 *
 * The bytes are copied by the caller; nothing here links the copy to its
 * source, so deleting the chat (or revoking the share) leaves the copy alone.
 *
 * @module services/artifacts/artifactAccess
 */
import { z } from 'zod';
import configCache from '../../configCache.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { authorizeChat } from '../chat/chatAccess.js';
import { getChatRepository } from '../chat/ChatRepository.js';
import { getChatShareRepository, isShareId } from '../chat/ChatShareRepository.js';
import { authorizeShareView } from '../chat/chatShareAccess.js';
import { isChatHistoryConfigured } from '../chat/chatPersistence.js';
import { isChatSharingConfigured } from '../chat/chatSharing.js';
import { getArtifactRepository } from './ArtifactRepository.js';
import { downloadName } from './artifactZip.js';

const idSchema = z.string().trim().min(1).max(200);

/** The reference of a chat artifact: by its chat, or by a share that names it. */
export const chatArtifactRefSchema = z.union([
  z.object({ chatId: idSchema, artifactId: idSchema }).strict(),
  z.object({ shareId: idSchema, artifactId: idSchema }).strict()
]);

function notFound() {
  return new ServiceError('NOT_FOUND', 'Artifact not found');
}

function sharingActive() {
  const features = configCache.getFeatures?.() || {};
  const platform = configCache.getPlatform?.() || {};
  if (!isChatHistoryConfigured(features, platform)) return false;
  if (!isChatSharingConfigured(features, platform)) return false;
  return getChatRepository().isAvailable() && getChatShareRepository().isAvailable();
}

/**
 * Read a chat artifact, payload included, as `user`.
 *
 * @param {unknown} ref - `{ chatId, artifactId }` or `{ shareId, artifactId }`.
 * @param {Object} user - `req.user`.
 * @returns {Promise<{bytes: Buffer, name: string, mimeType: string, kind: string,
 *   from: {type: 'chat', chatId: string, appId?: string, artifactId: string}
 *     | {type: 'share', shareId: string, artifactId: string}}>}
 *   `from` is what the copy records about where it came from.
 * @throws {ServiceError} `BAD_REQUEST` for a malformed reference, `NOT_FOUND`
 *   for anything the user cannot read.
 */
export async function readChatArtifact(ref, user) {
  const parsed = chatArtifactRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new ServiceError(
      'BAD_REQUEST',
      'An artifact reference is { chatId, artifactId } or { shareId, artifactId }'
    );
  }
  const { artifactId } = parsed.data;
  if (!isValidId(artifactId)) throw notFound();
  const chats = getChatRepository();
  if (!chats?.isAvailable?.()) throw notFound();

  let chatId;
  let from;
  if (parsed.data.shareId) {
    const { shareId } = parsed.data;
    if (!isShareId(shareId) || !sharingActive()) throw notFound();
    const share = await getChatShareRepository().getShare(shareId);
    const access = await authorizeShareView(share, user, { purpose: 'artifact' });
    // The allow-list is what the share named; nothing else of the chat.
    if (!access.ok || !(share.artifactIds || []).includes(artifactId)) throw notFound();
    chatId = share.chatId;
    // The recipient does not learn the owner's chat id.
    from = { type: 'share', shareId, artifactId };
  } else {
    chatId = parsed.data.chatId;
    if (!isValidId(chatId)) throw notFound();
    const auth = await authorizeChat(chatId, user, { repository: chats, intent: 'read' });
    if (!auth.ok || !auth.chat) throw notFound();
    from = {
      type: 'chat',
      chatId,
      ...(auth.chat.appId ? { appId: String(auth.chat.appId).slice(0, 200) } : {}),
      artifactId
    };
  }

  const artifact = await getArtifactRepository().get(chats.artifactScope(chatId), artifactId);
  if (!artifact || !artifact.data) throw notFound();
  const bytes = Buffer.isBuffer(artifact.data) ? artifact.data : Buffer.from(artifact.data);
  return {
    bytes,
    name: downloadName(artifact),
    mimeType: artifact.mimeType || 'application/octet-stream',
    kind: artifact.kind,
    from
  };
}
