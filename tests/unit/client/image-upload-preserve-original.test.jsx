// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * EU AI Act Art. 50(2), #3328: an uploaded picture that needs no resize goes out as the user's own
 * bytes, because the canvas re-encode drops C2PA / XMP and part of a SynthID signal. A picture
 * that is too large in pixels or bytes, or of a type the canvas must convert, is still re-encoded;
 * `preserveOriginal: false` restores the old behavior.
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));
jest.mock(
  'pdfjs-dist/legacy/build/pdf.mjs',
  () => ({ GlobalWorkerOptions: {}, getDocument: jest.fn() }),
  {
    virtual: true
  }
);
jest.mock('utif2', () => ({
  __esModule: true,
  default: { decode: jest.fn(), decodeImage: jest.fn(), toRGBA8: jest.fn() }
}));

const { processImageFile } = require('../../../client/src/features/upload/utils/fileProcessing');

const OriginalImage = global.Image;
let drawn;

function installImage(width, height) {
  global.Image = class {
    constructor() {
      this.naturalWidth = width;
      this.naturalHeight = height;
      this.width = width;
      this.height = height;
    }
    set src(value) {
      this._src = value;
      setTimeout(() => this.onload && this.onload(), 0);
    }
  };
}

beforeEach(() => {
  drawn = jest.fn();
  global.URL.createObjectURL = jest.fn(() => 'blob:preview');
  HTMLCanvasElement.prototype.getContext = jest.fn(() => ({ drawImage: drawn }));
  HTMLCanvasElement.prototype.toDataURL = jest.fn(() => 'data:image/jpeg;base64,RECOMPRESSED');
});

afterEach(() => {
  global.Image = OriginalImage;
});

const picture = (type = 'image/png', size = 1000) =>
  new File([new Uint8Array(size).fill(7)], 'generated.png', { type });
const originalDataUrl = file =>
  new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });

describe('processImageFile keeps the original bytes when no resize is needed', () => {
  it('sends the file as it is and never touches the canvas', async () => {
    installImage(800, 600);
    const file = picture();
    const result = await processImageFile(file, { maxDimension: 1024, resize: true });
    expect(result.data.base64).toBe(await originalDataUrl(file));
    expect(result.data.fileType).toBe('image/png');
    expect(result.data.width).toBe(800);
    expect(drawn).not.toHaveBeenCalled();
  });

  it('re-encodes a picture larger than the limit in pixels', async () => {
    installImage(3000, 2000);
    const result = await processImageFile(picture(), { maxDimension: 1024, resize: true });
    expect(result.data.base64).toBe('data:image/jpeg;base64,RECOMPRESSED');
    expect(result.data.fileType).toBe('image/jpeg');
    expect(drawn).toHaveBeenCalled();
  });

  it('re-encodes a small-in-pixels but very large file', async () => {
    installImage(800, 600);
    const result = await processImageFile(picture('image/png', 5 * 1024 * 1024), {
      maxDimension: 1024,
      resize: true
    });
    expect(result.data.base64).toBe('data:image/jpeg;base64,RECOMPRESSED');
  });

  it('re-encodes a type the canvas must convert (BMP)', async () => {
    installImage(800, 600);
    const result = await processImageFile(picture('image/bmp'), {
      maxDimension: 1024,
      resize: true
    });
    expect(result.data.fileType).toBe('image/jpeg');
  });

  it('preserveOriginal: false restores the always-recompress behavior', async () => {
    installImage(800, 600);
    const result = await processImageFile(picture(), {
      maxDimension: 1024,
      resize: true,
      preserveOriginal: false
    });
    expect(result.data.base64).toBe('data:image/jpeg;base64,RECOMPRESSED');
  });
});
