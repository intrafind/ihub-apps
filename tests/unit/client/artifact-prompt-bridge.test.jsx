// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * `sendPrompt` of an HTML artifact: the frame posts a question, the preview
 * shows it, and only the user's click sends it to the chat. Messages from any
 * other window are ignored, and a waiting question cannot be swapped.
 */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key)
  })
}));
jest.mock('../../../client/src/config/marked.config', () => ({
  highlightCode: code => code,
  renderMarkdown: text => `<p>${text}</p>`
}));
jest.mock('../../../client/src/utils/mermaidSecurity', () => ({ sanitizeMermaidSvg: s => s }));

const ArtifactPreview =
  require('../../../client/src/features/chat/components/ArtifactPreview').default;

const blobOf = text => {
  const blob = new Blob([text]);
  blob.text = async () => text;
  return blob;
};
const html = { id: 'h', name: 'page.html', kind: 'code', mimeType: 'text/html' };
const getBlob = jest.fn(async () => blobOf('<button>Ask</button>'));

async function frameOf() {
  return waitFor(() => {
    const el = document.querySelector('iframe');
    expect(el).not.toBeNull();
    return el;
  });
}

/** What `parent.postMessage` in the frame delivers to the page. */
function postFrom(source, data) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  });
}

const ask = text => ({ type: 'ihub-artifact:send-prompt', text });

describe('the sendPrompt bridge of an HTML artifact', () => {
  it('shows the question and sends it only after the user confirms', async () => {
    const send = jest.fn();
    render(
      <ArtifactPreview
        artifact={html}
        getBlob={getBlob}
        promptHost={{ send, isProcessing: false }}
      />
    );
    const frame = await frameOf();
    expect(frame.getAttribute('srcdoc')).toContain('sendPrompt.available=true');

    postFrom(frame.contentWindow, ask('Why did Q3 drop?'));
    const request = screen.getByTestId('artifact-prompt-request');
    expect(request).toHaveTextContent('Why did Q3 drop?');
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveFocus();

    // A second question while one waits is ignored: the text cannot be swapped.
    postFrom(frame.contentWindow, ask('Something else'));
    expect(request).toHaveTextContent('Why did Q3 drop?');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(send).toHaveBeenCalledWith('Why did Q3 drop?');
    expect(screen.queryByTestId('artifact-prompt-request')).not.toBeInTheDocument();
  });

  it('drops the question on Cancel and on Escape', async () => {
    const send = jest.fn();
    render(
      <ArtifactPreview
        artifact={html}
        getBlob={getBlob}
        promptHost={{ send, isProcessing: false }}
      />
    );
    const frame = await frameOf();
    postFrom(frame.contentWindow, ask('One'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('artifact-prompt-request')).not.toBeInTheDocument();

    postFrom(frame.contentWindow, ask('Two'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Send' }), { key: 'Escape' });
    expect(screen.queryByTestId('artifact-prompt-request')).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores messages from other windows and malformed ones', async () => {
    render(
      <ArtifactPreview
        artifact={html}
        getBlob={getBlob}
        promptHost={{ send: jest.fn(), isProcessing: false }}
      />
    );
    const frame = await frameOf();
    postFrom(window, ask('From the page itself'));
    postFrom(null, ask('From nowhere'));
    postFrom(frame.contentWindow, { type: 'other', text: 'x' });
    postFrom(frame.contentWindow, ask('   '));
    expect(screen.queryByTestId('artifact-prompt-request')).not.toBeInTheDocument();
  });

  it('cannot send while an answer is being written', async () => {
    const send = jest.fn();
    render(
      <ArtifactPreview
        artifact={html}
        getBlob={getBlob}
        promptHost={{ send, isProcessing: true }}
      />
    );
    const frame = await frameOf();
    postFrom(frame.contentWindow, ask('Later'));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('still being written');
  });

  it('without a chat the frame gets a no-op sendPrompt and nothing is listened to', async () => {
    render(<ArtifactPreview artifact={html} getBlob={getBlob} />);
    const frame = await frameOf();
    expect(frame.getAttribute('srcdoc')).toContain('sendPrompt.available=false');
    postFrom(frame.contentWindow, ask('Hello'));
    expect(screen.queryByTestId('artifact-prompt-request')).not.toBeInTheDocument();
  });
});
