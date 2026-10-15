import { saveBlobAs } from '../../../utils/externalNavigation';

/**
 * Helpers for the audio track that was extracted from an uploaded video (see
 * `extractAudioFromVideo`) and is attached as a `.wav` file.
 */

/** Is this attachment audio that was extracted from a video, with data to save? */
export const canSaveExtractedAudio = attachment =>
  attachment?.type === 'audio' &&
  attachment.extractedFromVideo === true &&
  (attachment.blob instanceof Blob || Boolean(attachment.base64));

/** Turn a base64 data URL into a Blob. Returns `null` when it is not one. */
const dataUrlToBlob = (dataUrl, fallbackType) => {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  if (comma < 0 || !/^data:.*;base64$/i.test(header)) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: header.slice('data:'.length).split(';')[0] || fallbackType });
};

/**
 * The WAV of an extracted-audio attachment. The attachment carries it as a
 * non-enumerable `blob`, which a copy of the attachment does not keep, so fall
 * back to the base64 data URL that is always part of it.
 */
export const getExtractedAudioBlob = attachment => {
  if (attachment?.blob instanceof Blob) return attachment.blob;
  if (typeof attachment?.base64 !== 'string') return null;
  try {
    return dataUrlToBlob(attachment.base64, attachment.fileType || 'audio/wav');
  } catch {
    return null; // not valid base64
  }
};

/**
 * Save the extracted audio to the user's disk as the attachment's file name
 * (`<video name>.wav`).
 *
 * @returns {boolean} `true` when the download was triggered.
 */
export const saveExtractedAudio = attachment => {
  const blob = getExtractedAudioBlob(attachment);
  return Boolean(blob) && saveBlobAs(blob, attachment.fileName || 'audio.wav');
};
