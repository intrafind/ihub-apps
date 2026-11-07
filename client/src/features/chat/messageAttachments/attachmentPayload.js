// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The files of one message as the send path needs them: what goes to the
 * server (`apiMessage.imageData` / `audioData` / `fileData`), never what the
 * bubble shows. The bubble is drawn from the attachment views
 * (`attachmentViews.js`); a message's `content` is plain text.
 *
 * @module features/chat/messageAttachments/attachmentPayload
 */

import { modelTakesFileKind } from '../../../shared/utils/modelInputCapabilities';

/**
 * Attachments as the uploader holds them and as the API takes them: none
 * (`null`), one object, or a list. The same rule for images, audio and
 * documents, and for restoring a resend into the composer.
 *
 * @param {Object[]} files
 * @returns {Object|Object[]|null}
 */
export function toApiFileField(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  return files.length === 1 ? files[0] : files;
}

/**
 * Split what the composer holds (nothing, one attachment or a list) into the
 * three kinds the API names. A document is an attachment whose `type` is
 * `document`; an entry of any other type is not sent as a file.
 *
 * @param {Object|Object[]|null|undefined} selected - `fileUploadHandler.selectedFile`
 * @returns {{ images: Object[], audioFiles: Object[], documents: Object[] }}
 */
export function classifyFiles(selected) {
  const list = selected ? [selected].flat().filter(Boolean) : [];
  return {
    images: list.filter(file => file.type === 'image'),
    audioFiles: list.filter(file => file.type === 'audio'),
    documents: list.filter(file => file.type === 'document')
  };
}

/**
 * The three payload fields of `apiMessage` for the composer's attachments.
 *
 * @param {Object|Object[]|null|undefined} selected - `fileUploadHandler.selectedFile`
 * @returns {{ imageData: Object|Object[]|null, audioData: Object|Object[]|null,
 *   fileData: Object|Object[]|null }}
 */
export function payloadFieldsOf(selected) {
  const { images, audioFiles, documents } = classifyFiles(selected);
  return {
    imageData: toApiFileField(images),
    audioData: toApiFileField(audioFiles),
    fileData: toApiFileField(documents)
  };
}

/**
 * Whether the composer holds images the selected model cannot take. The uploader only offers
 * images to a model with vision, so this is the case where the model was switched after the
 * image was attached: the message must not go out to a model that cannot see it.
 *
 * @param {Object|Object[]|null|undefined} selected - `fileUploadHandler.selectedFile`
 * @param {Object|null|undefined} model - the selected model as `/api/models` serves it
 * @returns {boolean}
 */
export function imagesNeedVision(selected, model) {
  return classifyFiles(selected).images.length > 0 && !modelTakesFileKind('image', model);
}
