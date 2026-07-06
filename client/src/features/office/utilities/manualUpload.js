const MANUAL_UPLOAD_TYPES = ['image', 'file', 'document'];

export function isManualUploadType(type) {
  return MANUAL_UPLOAD_TYPES.includes(type);
}

export function pickManualUpload(data) {
  if (!data) return null;
  const arr = Array.isArray(data) ? data : [data];
  const manuals = arr.filter(d => d && isManualUploadType(d.type));
  return manuals.length > 0 ? manuals[0] : null;
}
