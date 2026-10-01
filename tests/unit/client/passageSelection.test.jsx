import {
  hasPassageText,
  selectPreviewPassages
} from '../../../client/src/features/documentPreview/utils/passageSelection.js';

describe('passageSelection', () => {
  describe('hasPassageText', () => {
    it.each([
      ['a real passage', true],
      ['', false],
      ['   ', false],
      ['\n\t ', false]
    ])('should treat %j as usable=%s', (content, expected) => {
      expect(hasPassageText({ text: content })).toBe(expected);
    });

    it('should reject passages with no or non-string content', () => {
      expect(hasPassageText({})).toBe(false);
      expect(hasPassageText({ text: null })).toBe(false);
      expect(hasPassageText({ text: 42 })).toBe(false);
      expect(hasPassageText(undefined)).toBe(false);
    });
  });

  describe('selectPreviewPassages', () => {
    it('should return every usable passage and focus none by default', () => {
      const list = [{ text: 'first passage' }, { text: 'second passage' }];
      expect(selectPreviewPassages(list)).toEqual({
        passages: ['first passage', 'second passage'],
        initialPassageIndex: -1
      });
    });

    it('should index the focused passage against the filtered list', () => {
      // The blank passage is dropped, so the third displayed passage is the
      // second one the preview renders. An index taken from the displayed list
      // would have focused the wrong passage here.
      const blank = { text: '   ' };
      const target = { text: 'the passage the user clicked' };
      const list = [{ text: 'first passage' }, blank, target];

      expect(selectPreviewPassages(list, target)).toEqual({
        passages: ['first passage', 'the passage the user clicked'],
        initialPassageIndex: 1
      });
    });

    it('should drop leading unusable passages without shifting the focus', () => {
      const target = { text: 'only real passage' };
      const list = [{ text: '' }, { text: '  ' }, target];

      expect(selectPreviewPassages(list, target)).toEqual({
        passages: ['only real passage'],
        initialPassageIndex: 0
      });
    });

    it('should report no focus when the focused passage is itself unusable', () => {
      const blank = { text: '   ' };
      const list = [{ text: 'real passage' }, blank];

      expect(selectPreviewPassages(list, blank)).toEqual({
        passages: ['real passage'],
        initialPassageIndex: -1
      });
    });

    it('should handle an empty or missing list', () => {
      expect(selectPreviewPassages([])).toEqual({ passages: [], initialPassageIndex: -1 });
      expect(selectPreviewPassages(undefined)).toEqual({ passages: [], initialPassageIndex: -1 });
    });
  });
});
