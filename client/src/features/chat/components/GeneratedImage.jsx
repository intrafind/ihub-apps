import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchChatArtifact } from '../../../api';
import { useArtifactFetcher } from '../contexts/ArtifactFetchContext';

/**
 * One image an assistant turn produced.
 *
 * The same picture reaches this component in two shapes, and which one it is
 * says everything about what has to happen:
 *
 * - **Live** — `{ mimeType, data }`, base64 straight off the run's stream. It
 *   is already in memory, so it renders from a data URI with no request.
 * - **Stored** — `{ id, kind: 'image', mimeType, bytes }`, the artifact
 *   descriptor a durable chat keeps on the message. The payload lives in its
 *   own document server-side and is fetched here, once the message is both
 *   rendered and scrolled near the viewport. That is the whole reason opening
 *   a chat is fast even when it produced a dozen pictures: the transcript
 *   carries descriptors, not megabytes, and a picture below the fold does not
 *   compete with the ones the viewer is actually looking at.
 * - **Unavailable** — a descriptor with `unavailable`, or the `_hadImageData`
 *   marker the browser-storage path leaves behind. There is nothing to show,
 *   so the component says so rather than rendering a broken picture.
 *
 * Fetched through `apiClient` rather than pointed at by an `<img src>`: the URL
 * is credentialed, and a bearer token kept in `localStorage` only travels on a
 * request the client makes itself.
 *
 * @param {Object} props
 * @param {Object} props.image - Image as the message carries it: a live payload,
 *   a stored artifact descriptor, or one marked unavailable.
 * @param {string} [props.chatId] - Chat the image belongs to; required to fetch a stored one.
 * @param {number} props.index - Position in the message, for the alt text.
 * @param {boolean} [props.persisted] - Whether this chat stores its images. Drives the
 *   "download it or lose it" note, which is true only where nothing else keeps them.
 * @returns {JSX.Element|null}
 */
function GeneratedImage({ image, chatId, index, persisted = false }) {
  // A shared chat serves its images through the share rather than the
  // owner's chat route; the page providing that route says so via context.
  const customFetch = useArtifactFetcher();
  const { t } = useTranslation();
  const storedId = !image?.data && !image?.unavailable ? image?.id : null;
  const containerRef = useRef(null);
  // Seeded rather than set from an effect: where IntersectionObserver does
  // not exist (older browsers, this test environment), there is nothing to
  // wait on, so the image is visible from the start instead of forever.
  const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [objectUrl, setObjectUrl] = useState(null);
  // Which image failed, rather than a bare boolean: the flag then resets by
  // itself when the descriptor changes, instead of needing a write on every
  // render that starts a fetch.
  const [failedId, setFailedId] = useState(null);
  const failed = failedId !== null && failedId === storedId;

  // A stored image waits for its own visibility before it fetches anything:
  // reopening a chat mounts every message — and every image in it — at once,
  // so without this a long, image-heavy chat would fetch all of them before
  // the viewer scrolled near most of them. `rootMargin` starts the fetch a
  // little before the picture is actually on screen, so it is usually there
  // by the time scrolling reaches it.
  useEffect(() => {
    if (!storedId || isVisible) return undefined;
    const node = containerRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [storedId, isVisible]);

  useEffect(() => {
    if (!storedId || !chatId || !isVisible) return undefined;
    let url = null;
    let active = true;
    (async () => {
      try {
        const blob = await (customFetch || fetchChatArtifact)(chatId, storedId);
        // Revoked in the cleanup below — but only once it has been handed to
        // the element. Revoking a URL the browser has not loaded yet is what
        // turns a slow render into a broken image.
        url = URL.createObjectURL(blob);
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        setObjectUrl(url);
      } catch (err) {
        if (!active) return;
        console.warn('Could not load a stored image:', err.message);
        setFailedId(storedId);
      }
    })();
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [chatId, storedId, isVisible, customFetch]);

  const src = image?.data
    ? `data:${image.mimeType || 'image/png'};base64,${image.data}`
    : objectUrl;

  // Waiting to scroll into view, or the fetch is in flight: either way a
  // picture is coming, so a placeholder takes its place instead of the gap
  // `return null` used to leave for the whole time it takes to arrive.
  if (storedId && !src && !failed) {
    return (
      <div
        ref={containerRef}
        className="mt-3 flex h-48 w-64 max-w-full items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800"
        role="status"
        aria-label={t('chatMessage.loadingImage', 'Loading image…')}
      >
        <div
          className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600"
          aria-hidden="true"
        ></div>
      </div>
    );
  }

  if (!src) {
    // Nothing to render: the descriptor says the image was never stored, the
    // browser copy dropped the payload, or the fetch failed. The text names
    // the reason so "my picture is gone" has an answer.
    const unavailable = image?.unavailable || (failed ? 'fetch-failed' : null);
    if (!unavailable && !image?._hadImageData) return null;
    const detail =
      unavailable === 'too-large'
        ? t(
            'chatMessage.imageTooLargeToStore',
            'This image was larger than this installation stores, so it was not kept.'
          )
        : unavailable === 'too-many'
          ? t(
              'chatMessage.imageTooManyToStore',
              'This turn produced more images than this installation stores, so this one was not kept.'
            )
          : unavailable === 'fetch-failed'
            ? t('chatMessage.imageLoadFailed', 'The stored image could not be loaded.')
            : unavailable === 'not-stored'
              ? t(
                  'chatMessage.imageNotStored',
                  'This image could not be stored and is no longer available.'
                )
              : t(
                  'chatMessage.imageNotPersistedDetail',
                  'Generated images are not persisted when navigating away due to browser storage limitations. Images remain visible during the active session.'
                );
    return (
      <div className="mt-3 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
        <div className="flex items-start space-x-2">
          <Icon
            name="exclamation-circle"
            className="text-yellow-600 dark:text-yellow-500 shrink-0 mt-0.5"
          />
          <div className="text-sm text-yellow-800 dark:text-yellow-200">
            <p className="font-medium">
              {t('chatMessage.imageNotPersisted', 'Image not available')}
            </p>
            <p className="mt-1 text-yellow-700 dark:text-yellow-300">{detail}</p>
          </div>
        </div>
      </div>
    );
  }

  const download = () => {
    const link = document.createElement('a');
    link.href = src;
    link.download = `generated-image-${Date.now()}.${extensionFor(image?.mimeType)}`;
    link.click();
  };

  return (
    <div className="space-y-2">
      <div className="relative inline-block">
        <img
          src={src}
          alt={t('chatMessage.generatedImage', `Generated image ${index + 1}`)}
          className="max-w-full rounded-lg shadow-md"
          style={{ maxHeight: '512px' }}
        />
        <button
          onClick={download}
          className="absolute top-2 right-2 bg-white/90 hover:bg-white p-2 rounded-full shadow-lg transition-colors"
          title={t('chatMessage.downloadImage', 'Download image')}
          aria-label={t('chatMessage.downloadImage', 'Download image')}
        >
          <Icon name="download" size="sm" aria-hidden="true" />
        </button>
      </div>
      {/* Only where it is true: a durable chat stores its images server-side,
          and telling that user to download the picture or lose it is advice
          about a problem they do not have. */}
      {!persisted && (
        <div className="flex items-start space-x-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <Icon
            name="information-circle"
            className="text-blue-600 dark:text-blue-400 shrink-0 mt-0.5"
            size="sm"
          />
          <p className="text-xs text-blue-800 dark:text-blue-200">
            {t(
              'chatMessage.saveImageWarning',
              'Download this image to save it permanently. Images are not persisted when you navigate away due to browser storage limitations.'
            )}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * File extension for a downloaded image.
 *
 * @param {string} [mimeType] - Media type of the image.
 * @returns {string} Extension without the dot.
 */
function extensionFor(mimeType) {
  const subtype = String(mimeType || '')
    .split('/')[1]
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (!subtype || !/^[a-z0-9]+$/.test(subtype)) return 'png';
  return subtype === 'jpeg' ? 'jpg' : subtype;
}

export default GeneratedImage;
