import { processDocumentFile, getFileTypeDisplay, SUPPORTED_TEXT_FORMATS } from './fileProcessing';

const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/ogg'];

/**
 * Process a cloud-downloaded file into the same data shape as local uploads.
 * @param {File} file - File object created from downloaded blob
 * @param {Object} config - Upload config with resize settings
 * @returns {Promise<Object>} Data object matching UnifiedUploader output shape
 */
export async function processCloudFile(file, config = {}) {
  const mimeType = file.type;

  if (IMAGE_TYPES.includes(mimeType)) {
    return processCloudImage(file, config);
  }
  if (AUDIO_TYPES.includes(mimeType)) {
    return processCloudAudio(file);
  }
  // Document/text files
  return processCloudDocument(file);
}

/**
 * Process cloud image: resize and convert to base64
 */
async function processCloudImage(file, config) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Resize image
        const maxDimension = config.resizeMaxDimension || 1024;
        let { width, height } = img;

        if (config.resize !== false) {
          if (width > height && width > maxDimension) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else if (height > maxDimension) {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);

        const base64 = canvas.toDataURL(file.type, 0.9);

        resolve({
          type: 'image',
          base64,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          width,
          height
        });
      };
      img.onerror = () => reject(new Error('Image loading failed'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('File reading failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Process cloud audio: convert to base64
 */
async function processCloudAudio(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      resolve({
        type: 'audio',
        base64: e.target.result,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type
      });
    };
    reader.onerror = () => reject(new Error('File reading failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Process cloud document: extract text content
 */
async function processCloudDocument(file) {
  try {
    const content = await processDocumentFile(file);
    return {
      type: 'document',
      content,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      displayType: getFileTypeDisplay(file.type)
    };
  } catch (error) {
    console.error('Error processing cloud document:', error);
    throw error;
  }
}

/**
 * Check if file type is supported for cloud upload
 */
export function isCloudFileSupported(mimeType) {
  return (
    IMAGE_TYPES.includes(mimeType) ||
    AUDIO_TYPES.includes(mimeType) ||
    SUPPORTED_TEXT_FORMATS.includes(mimeType)
  );
}

/**
 * Format file size to human-readable string
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
