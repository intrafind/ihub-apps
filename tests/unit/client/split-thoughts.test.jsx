import { splitThoughts } from '../../../client/src/features/chat/splitThoughts';

describe('splitThoughts', () => {
  it('starts a new thought at each blank line', () => {
    expect(splitThoughts(['Step one.\n\nStep two.\n \nStep three.'])).toEqual([
      'Step one.',
      'Step two.',
      'Step three.'
    ]);
  });

  it('keeps single line breaks inside a thought', () => {
    expect(splitThoughts(['1. read\n2. answer'])).toEqual(['1. read\n2. answer']);
  });

  it('drops empty parts and passes named thoughts through', () => {
    const named = { name: 'planning', content: 'x' };
    expect(splitThoughts(['\n\nfirst\n\n\n\n', named, ''])).toEqual(['first', named]);
  });

  it('tolerates a missing list', () => {
    expect(splitThoughts(undefined)).toEqual([]);
  });
});
