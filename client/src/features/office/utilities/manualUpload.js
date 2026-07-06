export function pickManualUpload(data) {
  if (!data) return null;
  const arr = Array.isArray(data) ? data : [data];
  const manuals = arr.filter(
    d => d && (d.type === 'image' || d.type === 'file' || d.type === 'document')
  );
  return manuals.length > 0 ? manuals[0] : null;
}
