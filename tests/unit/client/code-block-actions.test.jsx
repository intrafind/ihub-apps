// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The toolbar under a code block in an answer: the download takes the file
 * name the fence gives (```js title="src/index.js"), the language label and
 * highlighting take only the language, the button feedback is translated,
 * and the toolbar is left out of a copied selection.
 */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) =>
      ({ 'common.copied': 'Kopiert!', 'common.downloaded': 'Heruntergeladen!' })[key] ||
      defaultValue,
    i18n: { language: 'de' }
  })
}));
jest.mock('../../../client/src/utils/externalNavigation', () => ({
  saveBlobAs: jest.fn(() => true)
}));

const { saveBlobAs } = require('../../../client/src/utils/externalNavigation');
const { parseCodeInfo, codeDownloadName } = require('../../../client/src/utils/markdownHelpers');
const { renderMarkdown } = require('../../../client/src/config/marked.config');
const { useCodeBlockInteractions } = require('../../../client/src/hooks/useCodeBlockInteractions');

describe('the info string of a code fence', () => {
  it('splits the language from the file name', () => {
    expect(parseCodeInfo('js title="src/index.js"')).toEqual({
      language: 'js',
      fileName: 'src/index.js'
    });
    expect(parseCodeInfo("ts filename='lib/a b.ts'")).toEqual({
      language: 'ts',
      fileName: 'lib/a b.ts'
    });
    expect(parseCodeInfo('Python file=app.py')).toEqual({ language: 'python', fileName: 'app.py' });
    expect(parseCodeInfo('python:app/main.py')).toEqual({
      language: 'python',
      fileName: 'app/main.py'
    });
    expect(parseCodeInfo('sql')).toEqual({ language: 'sql', fileName: '' });
    expect(parseCodeInfo('')).toEqual({ language: 'text', fileName: '' });
    expect(parseCodeInfo(undefined)).toEqual({ language: 'text', fileName: '' });
    // Nothing that could leave an attribute or a class name.
    expect(parseCodeInfo('j"s<x> title=a').language).toBe('jsx');
  });

  it('names the download after the file, or by the language', () => {
    expect(codeDownloadName('src/index.js', 'js')).toBe('index.js');
    expect(codeDownloadName('C:\\work\\run.ps1', 'powershell')).toBe('run.ps1');
    expect(codeDownloadName('Dockerfile', 'dockerfile')).toBe('Dockerfile');
    expect(codeDownloadName('a:b?.py', 'python')).toBe('a b .py');
    expect(codeDownloadName('', 'python')).toBe('code.py');
    expect(codeDownloadName('..', 'js')).toBe('code.js');
  });
});

describe('a rendered code block', () => {
  it('labels the language and carries the download name', () => {
    const html = renderMarkdown('```js title="src/index.js"\nconsole.log(1);\n```');
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(root.querySelector('code')).toHaveClass('language-js');
    expect(root.querySelector('.code-block-toolbar span')).toHaveTextContent('JavaScript');
    expect(root.querySelector('.code-block-toolbar')).toHaveClass('select-none');
    const download = root.querySelector('.code-download-btn');
    expect(download.dataset.codeLanguage).toBe('js');
    expect(decodeURIComponent(download.dataset.codeFilename)).toBe('index.js');
  });
});

function Host({ html }) {
  useCodeBlockInteractions();
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

describe('the toolbar buttons', () => {
  beforeEach(() => saveBlobAs.mockClear());

  it('download under the fence’s file name, with translated feedback', () => {
    const { container } = render(
      <Host html={renderMarkdown('```python:app/main.py\nprint(1)\n```')} />
    );
    const button = container.querySelector('.code-download-btn');
    fireEvent.click(button);
    expect(saveBlobAs).toHaveBeenCalledWith(expect.any(Blob), 'main.py');
    expect(button).toHaveTextContent('Heruntergeladen!');
  });

  it('download as code.<ext> when the fence names no file', () => {
    const { container } = render(<Host html={renderMarkdown('```sql\nselect 1;\n```')} />);
    fireEvent.click(container.querySelector('.code-download-btn'));
    expect(saveBlobAs).toHaveBeenCalledWith(expect.any(Blob), 'code.sql');
  });

  it('copy with translated feedback', async () => {
    const writeText = jest.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { container, findByText } = render(
      <Host html={renderMarkdown('```js\nconsole.log(1);\n```')} />
    );
    fireEvent.click(container.querySelector('.code-copy-btn'));
    expect(writeText).toHaveBeenCalledWith('console.log(1);');
    expect(await findByText('Kopiert!')).toBeInTheDocument();
  });
});
