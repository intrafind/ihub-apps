/**
 * Image lifting (chat behaviour): a tool result that carries an image
 * (`{ imageData: { type: 'image', base64, format?, filename? } }` anywhere in
 * the result tree) is turned into a vision-capable tool message — adapters
 * read `message.imageData` and the textual content becomes a short marker.
 * Last match wins (single image per result), as before.
 *
 * @module services/loop/seams/imageLiftSeam
 */

/**
 * @param {*} result
 * @returns {{type:'image', format:string, base64:string, filename:string}|null}
 */
export function extractImageData(result) {
  let found = null;
  const walk = obj => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.imageData && obj.imageData.type === 'image' && obj.imageData.base64) {
      found = {
        type: 'image',
        format: obj.imageData.format || 'image/jpeg',
        base64: obj.imageData.base64,
        filename: obj.imageData.filename || 'attachment'
      };
      return;
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(result);
  return found;
}

export const imageLiftSeam = {
  name: 'image-lift',
  postTool(_ctx, _info, outcome) {
    const image = extractImageData(outcome.rawResult);
    if (!image) return;
    outcome.message.imageData = image;
    outcome.message.content = `Retrieved image: ${image.filename}`;
  }
};
