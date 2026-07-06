import '@testing-library/jest-dom';

const {
  pickManualUpload
} = require('../../../client/src/features/office/utilities/manualUpload.js');

describe('pickManualUpload', () => {
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
