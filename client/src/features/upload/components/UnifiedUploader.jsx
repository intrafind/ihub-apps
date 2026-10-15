import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Uploader from './Uploader';
import ProcessingProgress from './ProcessingProgress';
import '../components/ImageUpload.css';
import {
  SUPPORTED_TEXT_FORMATS,
  GENERIC_TEXT_MIME_TYPE,
  getFileTypeDisplay as getFileTypeDisplayUtil,
  getExtensionDisplay,
  formatMimeTypesToDisplay,
  processDocumentFile,
  processGenericTextFile,
  formatAcceptAttribute,
  processImageFile,
  extractAudioFromVideo,
  loadMimetypesConfig,
  canonicalMimeType,
  withDataUrlMimeType,
  readFileAsDataURL
} from '../utils/fileProcessing';
import { extractionOptionsOf } from '../utils/extractionOptions';
import { isAbortError } from '../../../utils/abortable';

/**
 * Unified uploader component that handles both images and files in a single interface.
 * Automatically detects file type and applies appropriate processing.
 * Wraps children with drag-drop handlers to make any area a drop zone.
 *
 * While a file is processed (extracting the audio of a video can take minutes)
 * a progress panel with a Stop button shows above the children.
 * `onProcessingChange(true|false)` tells the parent when an attachment is on its
 * way, so it can hold back sending until it is attached.
 */
const UnifiedUploader = ({
  onFileSelect,
  onProcessingChange,
  disabled = false,
  fileData = null,
  config = {},
  openDialogRef = null,
  children
}) => {
  const { t } = useTranslation();

  // Load the server mimetypes config so the file picker's `accept` attribute
  // gets real file extensions (e.g. `.msg`, `.eml`, `.xlsx`). Without it the
  // module falls back to a minimal DEFAULT_CONFIG that only knows a handful of
  // extensions; non-standard MIME types like `application/vnd.ms-outlook` then
  // reach the OS dialog without a matching extension, so `.msg` files appear
  // greyed out and cannot be selected. `.eml` survives because its MIME type
  // (`message/rfc822`) is recognised by the OS even without the extension.
  // The load is cached/idempotent; the state flip forces a single re-render so
  // the synchronous format helpers below recompute against the loaded config.
  const [, setMimetypesLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    loadMimetypesConfig().finally(() => {
      if (active) setMimetypesLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Image upload configuration
  const imageConfig = config.imageUpload || {};
  const isImageUploadEnabled = imageConfig.enabled !== false && config.imageUploadEnabled !== false;

  // Audio upload configuration
  const audioConfig = config.audioUpload || {};
  const isAudioUploadEnabled = audioConfig.enabled !== false && config.audioUploadEnabled !== false;

  // Video upload configuration
  const videoConfig = config.videoUpload || {};
  const isVideoUploadEnabled = videoConfig.enabled !== false && config.videoUploadEnabled !== false;
  const extractAudioFromVideoEnabled =
    videoConfig.extractAudio !== false && config.extractAudioFromVideo !== false;

  // File upload configuration
  const fileConfig = config.fileUpload || {};
  const isFileUploadEnabled = fileConfig.enabled !== false && config.fileUploadEnabled !== false;

  // Multiple file upload configuration - read from top-level upload config
  const allowMultiple = config.allowMultiple || false;

  // Configuration with defaults
  const MAX_FILE_SIZE_MB =
    config.maxFileSizeMB ||
    Math.max(
      imageConfig.maxFileSizeMB || 0,
      audioConfig.maxFileSizeMB || 0,
      videoConfig.maxFileSizeMB || 0,
      fileConfig.maxFileSizeMB || 0
    ) ||
    10;

  // Image-specific configuration
  const IMAGE_FORMATS = isImageUploadEnabled
    ? imageConfig.supportedFormats ||
      config.supportedImageFormats || [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp'
      ]
    : [];
  const RESIZE_IMAGES = imageConfig.resizeImages !== false && config.resizeImages !== false;
  const MAX_DIMENSION = imageConfig.maxResizeDimension || config.maxResizeDimension || 1024;

  // Audio-specific configuration
  const AUDIO_FORMATS = isAudioUploadEnabled
    ? audioConfig.supportedFormats ||
      config.supportedAudioFormats || [
        'audio/mpeg',
        'audio/mp3',
        'audio/wav',
        'audio/flac',
        'audio/ogg',
        'audio/mp4'
      ]
    : [];

  // Video-specific configuration
  const VIDEO_FORMATS = isVideoUploadEnabled
    ? videoConfig.supportedFormats ||
      config.supportedVideoFormats || ['video/mp4', 'video/webm', 'video/quicktime']
    : [];

  // File-specific configuration
  const TEXT_FORMATS = isFileUploadEnabled
    ? fileConfig.supportedFormats || config.supportedFormats || SUPPORTED_TEXT_FORMATS
    : [];

  // All supported formats combined - include both MIME types and file extensions for better OS compatibility
  const ALL_FORMATS = formatAcceptAttribute([
    ...IMAGE_FORMATS,
    ...AUDIO_FORMATS,
    ...VIDEO_FORMATS,
    ...TEXT_FORMATS
  ]);

  // "Any text file" (text/*) opts into content-based acceptance: the picker is
  // left unfiltered and a file not matching an explicit format is read as
  // plain text and rejected if it turns out to be binary.
  const ALLOW_GENERIC_TEXT = TEXT_FORMATS.includes(GENERIC_TEXT_MIME_TYPE);
  const EXPLICIT_TEXT_FORMATS = formatAcceptAttribute(
    TEXT_FORMATS.filter(format => format !== GENERIC_TEXT_MIME_TYPE)
  );
  const isExplicitTextFile = file => {
    if (file.type && EXPLICIT_TEXT_FORMATS.includes(file.type)) return true;
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
    return EXPLICIT_TEXT_FORMATS.includes(fileExtension);
  };

  const isImageFile = type => IMAGE_FORMATS.includes(type);
  const isAudioFile = type => AUDIO_FORMATS.includes(type);
  const isVideoFile = type => VIDEO_FORMATS.includes(type);

  const getFileTypeDisplay = (mimeType, fileName = '') => {
    // Image types
    if (isImageFile(mimeType)) {
      return mimeType.replace('image/', '').toUpperCase();
    }

    // Audio types
    if (isAudioFile(mimeType)) {
      // An .m4a is an audio/mp4 file; show it as the format the user picked, not "MP4"
      if (mimeType === 'audio/mp4' && /\.m4a$/i.test(fileName)) return 'M4A';
      return mimeType.replace('audio/', '').toUpperCase();
    }

    // Video types
    if (isVideoFile(mimeType)) {
      return mimeType.replace('video/', '').toUpperCase();
    }

    // Use shared utility for document types
    return getFileTypeDisplayUtil(mimeType);
  };

  const processImage = file =>
    processImageFile(file, {
      maxDimension: MAX_DIMENSION,
      resize: RESIZE_IMAGES,
      allowMultiple
    });

  // `options`: { signal, onProgress } from the Uploader
  const processAudio = async (file, mimeType, { signal, onProgress } = {}) => {
    // For audio files, we just need to read the base64 data
    // No processing or resizing is needed. The data URL carries the canonical
    // MIME type: the adapters only strip the prefix of plain type names.
    const dataUrl = await readFileAsDataURL(file, {
      signal,
      onProgress: percent => onProgress?.({ stage: 'read', percent })
    });
    return {
      preview: {
        type: 'audio',
        fileName: file.name,
        fileType: getFileTypeDisplay(mimeType, file.name),
        fileSize: file.size
      },
      data: {
        type: 'audio',
        source: 'local',
        base64: withDataUrlMimeType(dataUrl, mimeType),
        fileName: file.name,
        fileSize: file.size,
        fileType: mimeType
      }
    };
  };

  const processVideo = async (file, { signal, onProgress } = {}) => {
    // Extract audio from video if enabled
    if (extractAudioFromVideoEnabled) {
      try {
        const audioData = await extractAudioFromVideo(file, { signal, onProgress });

        // Generate new filename for extracted audio
        const baseFileName = file.name.replace(/\.[^/.]+$/, ''); // Remove extension
        const audioFileName = `${baseFileName}.wav`;

        const data = {
          type: 'audio',
          source: 'local',
          base64: audioData.base64,
          fileName: audioFileName,
          fileSize: audioData.size,
          fileType: audioData.format,
          extractedFromVideo: true,
          originalVideoName: file.name,
          duration: audioData.duration,
          sampleRate: audioData.sampleRate,
          channels: audioData.channels
        };
        // The WAV Blob travels with the attachment, so transcription decodes it
        // directly instead of re-parsing the base64 string. Non-enumerable:
        // attachments are JSON-serialized into the chat history, sessionStorage
        // and the request body, where a Blob would turn into a bogus `{}`.
        Object.defineProperty(data, 'blob', {
          value: audioData.blob,
          enumerable: false,
          writable: true,
          configurable: true
        });

        return {
          preview: {
            type: 'audio',
            fileName: audioFileName,
            fileType: 'WAV',
            fileSize: audioData.size,
            extractedFrom: file.name,
            duration: audioData.duration
          },
          data
        };
      } catch (error) {
        // Stopping is not a failure to log
        if (!isAbortError(error)) console.error('Error extracting audio from video:', error);
        throw error;
      }
    }

    // If audio extraction is not enabled, treat as regular file
    // (Some models might support video directly)
    const mimeType = canonicalMimeType(file.type, file.name);
    const dataUrl = await readFileAsDataURL(file, {
      signal,
      onProgress: percent => onProgress?.({ stage: 'read', percent })
    });
    return {
      preview: {
        type: 'video',
        fileName: file.name,
        fileType: getFileTypeDisplay(mimeType),
        fileSize: file.size
      },
      data: {
        type: 'video',
        source: 'local',
        base64: withDataUrlMimeType(dataUrl, mimeType),
        fileName: file.name,
        fileSize: file.size,
        fileType: mimeType
      }
    };
  };

  // `options`: { signal, onProgress } from the Uploader
  const processFile = async (file, options = {}) => {
    // Route by the canonical type (`audio/x-m4a` → `audio/mp4`); a type the app lists
    // verbatim keeps matching too
    const mimeType = canonicalMimeType(file.type, file.name);
    const isListed = formats => formats.includes(file.type) || formats.includes(mimeType);

    // Check if image files are disabled
    if (!isImageUploadEnabled && isListed(IMAGE_FORMATS)) {
      throw new Error('image-upload-disabled');
    }

    // Check if audio files are disabled
    if (!isAudioUploadEnabled && isListed(AUDIO_FORMATS)) {
      throw new Error('audio-upload-disabled');
    }

    // Check if video files are disabled
    if (!isVideoUploadEnabled && isListed(VIDEO_FORMATS)) {
      throw new Error('video-upload-disabled');
    }

    // Check if file upload is disabled
    if (!isFileUploadEnabled && isListed(TEXT_FORMATS)) {
      throw new Error('file-upload-disabled');
    }

    // Handle image files
    if (isListed(IMAGE_FORMATS)) {
      return await processImage(file);
    }

    // Handle audio files
    if (isListed(AUDIO_FORMATS)) {
      return await processAudio(file, mimeType, options);
    }

    // Handle video files
    if (isListed(VIDEO_FORMATS)) {
      return await processVideo(file, options);
    }

    // Handle text/document files using shared utility. Files that only pass
    // because "any text file" is allowed are read as plain text — never run
    // through a format-specific extractor the admin did not enable.
    const isGenericText = ALLOW_GENERIC_TEXT && !isExplicitTextFile(file);
    const { content: processedContent, pageImages } = isGenericText
      ? await processGenericTextFile(file)
      : await processDocumentFile(file, extractionOptionsOf(fileConfig));
    const displayContent = processedContent || '';
    const previewContent =
      displayContent.length > 200 ? displayContent.substring(0, 200) + '...' : displayContent;
    const displayType = isGenericText
      ? getExtensionDisplay(file.name)
      : getFileTypeDisplay(file.type);

    return {
      preview: {
        type: 'document',
        fileName: file.name,
        fileType: displayType,
        content: previewContent
      },
      data: {
        type: 'document',
        source: 'local',
        content: processedContent,
        pageImages,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || (isGenericText ? 'text/plain' : ''),
        displayType
      }
    };
  };

  const formatList = (() => {
    const imageFormats = IMAGE_FORMATS.map(format => format.replace('image/', '').toUpperCase());
    // audio/mp4 covers .m4a files; name it so users looking for M4A find it
    const audioFormats = AUDIO_FORMATS.map(format =>
      format === 'audio/mp4' ? 'M4A, MP4' : format.replace('audio/', '').toUpperCase()
    );
    const videoFormats = VIDEO_FORMATS.map(format => format.replace('video/', '').toUpperCase());
    const textFormatsDisplay = formatMimeTypesToDisplay(TEXT_FORMATS);
    const allFormats = [
      ...imageFormats,
      ...audioFormats,
      ...videoFormats,
      textFormatsDisplay.length > 0 ? textFormatsDisplay : null
    ]
      .filter(Boolean)
      .join(', ');
    return allFormats;
  })();

  const getErrorMessage = code => {
    switch (code) {
      case 'file-too-large':
        return t('errors.fileTooLarge', {
          maxSize: MAX_FILE_SIZE_MB,
          defaultValue: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`
        });
      case 'unsupported-format':
        return t('errors.unsupportedFormat', {
          formats: formatList,
          defaultValue: `Unsupported file format. Please use: ${formatList}`
        });
      case 'invalid-image':
        return t('errors.invalidImage', 'Invalid image file');
      case 'tiff-processing-error':
        return t(
          'errors.tiffProcessingError',
          'Error processing TIFF file. The file may be corrupted or in an unsupported TIFF format.'
        );
      case 'read-error':
        return t('errors.readError', 'Error reading file');
      case 'image-upload-disabled':
        return t(
          'errors.imageUploadDisabled',
          'Image upload is not supported by the selected model. Please choose a different model or upload a text file instead.'
        );
      case 'audio-upload-disabled':
        return t(
          'errors.audioUploadDisabled',
          'Audio upload is not supported by the selected model. Please choose a different model.'
        );
      case 'video-upload-disabled':
        return t(
          'errors.videoUploadDisabled',
          'Video upload is not supported by the selected model. Please choose a different model.'
        );
      case 'audio-decode-error':
        return t(
          'errors.audioDecodeError',
          'Could not decode audio from video. The video format or codec may not be supported by your browser.'
        );
      case 'video-audio-extraction-error':
        return t(
          'errors.videoAudioExtractionError',
          'Error extracting audio from video. Please ensure the video contains an audio track.'
        );
      case 'file-upload-disabled':
        return t('errors.fileUploadDisabled', 'File upload is disabled for this application.');
      default:
        return t('errors.fileProcessingError', 'Error processing file. Please try again.');
    }
  };

  return (
    <Uploader
      accept={ALL_FORMATS}
      maxSizeMB={MAX_FILE_SIZE_MB}
      disabled={disabled}
      onSelect={onFileSelect}
      onProcessFile={processFile}
      data={fileData}
      allowMultiple={allowMultiple}
      acceptAnyFile={ALLOW_GENERIC_TEXT}
      onProcessingChange={onProcessingChange}
    >
      {({
        error,
        isProcessing,
        progress,
        cancelProcessing,
        isDragging,
        handleButtonClick,
        handleDragEnter,
        handleDragLeave,
        handleDragOver,
        handleDrop,
        inputProps
      }) => {
        // Expose file dialog opener to parent via ref
        if (openDialogRef) {
          openDialogRef.current = handleButtonClick;
        }

        return (
          <div
            className="unified-uploader"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {/* Hidden file input */}
            <input {...inputProps} />

            {/* Drag overlay */}
            {isDragging && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-blue-500/20 dark:bg-blue-500/30 pointer-events-none"
                role="alert"
                aria-live="polite"
                aria-label={t(
                  'components.uploader.dropZoneActive',
                  'Drop zone active. Release to upload files.'
                )}
              >
                <div className="bg-white dark:bg-gray-800 rounded-lg shadow-2xl p-8 border-4 border-blue-500 border-dashed">
                  <div className="text-center">
                    <div className="text-6xl mb-4">📎</div>
                    <p className="text-xl font-semibold text-blue-600 dark:text-blue-400">
                      {t('components.uploader.dropFileHere', 'Drop file here')}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Progress while a file is processed */}
            {isProcessing && <ProcessingProgress progress={progress} onStop={cancelProcessing} />}

            {/* Error message */}
            {error && (
              <div className="text-red-500 text-sm mb-2 px-2">{getErrorMessage(error)}</div>
            )}

            {/* Wrapped children (form + file list) */}
            {children}
          </div>
        );
      }}
    </Uploader>
  );
};

export default UnifiedUploader;
