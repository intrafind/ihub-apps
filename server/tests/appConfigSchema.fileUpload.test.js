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
