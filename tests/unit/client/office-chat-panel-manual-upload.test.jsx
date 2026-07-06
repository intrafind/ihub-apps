import '@testing-library/jest-dom';

const {
  isManualUploadType,
  pickManualUpload
} = require('../../../client/src/features/office/utilities/manualUpload.js');

describe('pickManualUpload', () => {
  test('recognizes manual upload types', () => {
    expect(isManualUploadType('document')).toBe(true);
    expect(isManualUploadType('file')).toBe(true);
    expect(isManualUploadType('image')).toBe(true);
    expect(isManualUploadType('audio')).toBe(false);
  });

  test('accepts document uploads as manual files', () => {
    const upload = { type: 'document', fileName: 'policy.pdf' };
    expect(pickManualUpload(upload)).toEqual(upload);
  });

  test('keeps backward compatibility for legacy file type', () => {
    const upload = { type: 'file', fileName: 'legacy.pdf' };
    expect(pickManualUpload(upload)).toEqual(upload);
  });

  test('returns first manual upload from arrays', () => {
    const arr = [{ fileName: 'host-attachment.pdf' }, { type: 'document', fileName: 'manual.pdf' }];
    expect(pickManualUpload(arr)).toEqual(arr[1]);
  });
});
