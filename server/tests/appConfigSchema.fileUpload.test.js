/**
 * Word review options and speaker notes of an app's file upload (concepts/document-extraction/, release 2, WP-B).
 *
 * Tracked changes and comments are opt-in per app: an app that does not mention them is
 * validated with the defaults `accepted` / `ignore`, which is what documents looked like before
 * the options existed. No migration writes anything into existing app files.
 */

import { appConfigSchema } from '../validators/appConfigSchema.js';

const app = upload => ({
  id: 'contract-review',
  name: { en: 'Contract review' },
  description: { en: 'Reviews contracts' },
  color: '#4F46E5',
  icon: 'document',
  upload
});

describe('app file upload: Word review options', () => {
  test('default to the accepted view without comments', () => {
    const result = appConfigSchema.safeParse(app({ fileUpload: { enabled: true } }));

    expect(result.success).toBe(true);
    expect(result.data.upload.fileUpload.trackedChanges).toBe('accepted');
    expect(result.data.upload.fileUpload.comments).toBe('ignore');
    expect(result.data.upload.fileUpload.speakerNotes).toBe('ignore');
  });

  test('an app without file upload settings is still valid', () => {
    expect(appConfigSchema.safeParse(app(undefined)).success).toBe(true);
    expect(appConfigSchema.safeParse(app({ imageUpload: { enabled: true } })).success).toBe(true);
  });

  test('accept the opt-in values and keep them', () => {
    const result = appConfigSchema.safeParse(
      app({
        fileUpload: {
          enabled: true,
          trackedChanges: 'markup',
          comments: 'inline',
          speakerNotes: 'include'
        }
      })
    );

    expect(result.success).toBe(true);
    expect(result.data.upload.fileUpload.trackedChanges).toBe('markup');
    expect(result.data.upload.fileUpload.comments).toBe('inline');
    expect(result.data.upload.fileUpload.speakerNotes).toBe('include');
  });

  test('reject values that are not options', () => {
    for (const fileUpload of [
      { trackedChanges: 'all' },
      { trackedChanges: true },
      { comments: 'yes' },
      { comments: 1 },
      { speakerNotes: 'all' },
      { speakerNotes: true }
    ]) {
      expect(appConfigSchema.safeParse(app({ fileUpload })).success).toBe(false);
    }
  });
});

describe('app file upload: size limit', () => {
  const limitOf = upload => {
    const result = appConfigSchema.safeParse(app(upload));
    expect(result.success).toBe(true);
    return result.data.upload.fileUpload.maxFileSizeMB;
  };

  test('is 20 MB for an app that does not set it', () => {
    expect(limitOf({ fileUpload: { enabled: true } })).toBe(20);
    expect(limitOf({ fileUpload: {} })).toBe(20);
  });

  test('keeps what the app set, including the old default of 5 MB', () => {
    expect(limitOf({ fileUpload: { enabled: true, maxFileSizeMB: 5 } })).toBe(5);
    expect(limitOf({ fileUpload: { enabled: true, maxFileSizeMB: 50 } })).toBe(50);
  });

  test('stays within 1 to 100 MB', () => {
    for (const maxFileSizeMB of [1, 100]) {
      expect(
        appConfigSchema.safeParse(app({ fileUpload: { enabled: true, maxFileSizeMB } })).success
      ).toBe(true);
    }
    for (const maxFileSizeMB of [0, 101]) {
      expect(
        appConfigSchema.safeParse(app({ fileUpload: { enabled: true, maxFileSizeMB } })).success
      ).toBe(false);
    }
  });

  test('has defaults of its own for the other upload types', () => {
    const { upload } = appConfigSchema.parse(
      app({ imageUpload: {}, audioUpload: {}, videoUpload: {}, fileUpload: {} })
    );
    expect(upload.imageUpload.maxFileSizeMB).toBe(10);
    expect(upload.audioUpload.maxFileSizeMB).toBe(20);
    expect(upload.videoUpload.maxFileSizeMB).toBe(50);
    expect(upload.fileUpload.maxFileSizeMB).toBe(20);
  });
});
