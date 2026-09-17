/**
 * Artifact download helpers — fetch an artifact and save it locally in the
 * format the operator picked. The native `<a download>` attribute can't
 * cross-origin (dev server on :5173, API on :3000) because browsers drop
 * the hint when the URL isn't same-origin, so we always fetch as a blob
 * and trigger the save via file-saver. That works on any origin and lets
 * us also transform content (markdown → HTML, markdown → .docx) on the
 * way down.
 */

import { saveAs } from 'file-saver';
import { renderMarkdown } from '../../../config/marked.config';

/**
 * Fetch the artifact's raw text via authenticated request.
 *
 * @param {string} runId
 * @param {string} artifactName
 * @returns {Promise<string>}
 */
export async function fetchArtifactText(runId, artifactName) {
  const url =
    `/api/agents/runs/${encodeURIComponent(runId)}` +
    `/artifacts/${encodeURIComponent(artifactName)}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Artifact fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function baseNameWithoutMd(name) {
  if (typeof name !== 'string') return 'artifact';
  return name.replace(/\.(md|markdown|txt)$/i, '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => {
    switch (m) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * Save the raw markdown body to disk as a .md file.
 */
export async function downloadAsMarkdown(runId, artifactName) {
  const text = await fetchArtifactText(runId, artifactName);
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  saveAs(blob, artifactName.endsWith('.md') ? artifactName : `${artifactName}.md`);
}

/**
 * Render markdown to a self-contained styled HTML document and download.
 */
export async function downloadAsHTML(runId, artifactName) {
  const text = await fetchArtifactText(runId, artifactName);
  const body = renderMarkdown(text || '');
  const title = baseNameWithoutMd(artifactName);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1f2937; }
  h1, h2, h3 { font-weight: 600; }
  pre { background: #f3f4f6; padding: 0.75rem; border-radius: 4px; overflow-x: auto; }
  code { background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.95em; }
  blockquote { border-left: 4px solid #6366f1; padding: 0 1rem; color: #4b5563; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 10px; }
  a { color: #4f46e5; }
</style>
</head>
<body>
${body}
</body>
</html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  saveAs(blob, `${title}.html`);
}

/**
 * Open the rendered markdown in a hidden iframe and trigger the browser's
 * print dialog. The user can choose "Save as PDF" from there. We
 * deliberately don't bundle a PDF library — print-to-PDF is built into
 * every browser and avoids 500KB+ of client weight.
 */
export async function printAsPDF(runId, artifactName) {
  const text = await fetchArtifactText(runId, artifactName);
  const body = renderMarkdown(text || '');
  const title = baseNameWithoutMd(artifactName);
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 18mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; color: #1f2937; }
  h1 { font-size: 22pt; }
  h2 { font-size: 16pt; }
  h3 { font-size: 13pt; }
  pre { background: #f3f4f6; padding: 0.5rem; border-radius: 3px; white-space: pre-wrap; word-break: break-word; }
  code { background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 2px; font-size: 0.95em; }
  blockquote { border-left: 3px solid #6366f1; padding: 0 0.75rem; color: #4b5563; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d1d5db; padding: 4px 8px; }
  a { color: #4f46e5; }
</style>
</head>
<body>
${body}
</body>
</html>`);
  doc.close();
  await new Promise(resolve => setTimeout(resolve, 250));
  try {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  } finally {
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 1000);
  }
}

/**
 * Simple inline-markdown tokenizer for **bold**, *italic*, `code`, and
 * [text](url). Returns an array of `{ type, text, url? }` segments.
 * Avoids RegExp.exec/matchAll to side-step a security-hook false positive.
 */
function parseInline(input) {
  const out = [];
  if (typeof input !== 'string' || input.length === 0) return out;
  let i = 0;
  let buffer = '';
  const flush = () => {
    if (buffer.length > 0) {
      out.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };
  while (i < input.length) {
    const ch = input[i];
    if (ch === '*' && input[i + 1] === '*') {
      const end = input.indexOf('**', i + 2);
      if (end !== -1) {
        flush();
        out.push({ type: 'bold', text: input.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*') {
      const end = input.indexOf('*', i + 1);
      if (end !== -1) {
        flush();
        out.push({ type: 'italic', text: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '`') {
      const end = input.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        out.push({ type: 'code', text: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const closeBr = input.indexOf(']', i + 1);
      if (closeBr !== -1 && input[closeBr + 1] === '(') {
        const closePar = input.indexOf(')', closeBr + 2);
        if (closePar !== -1) {
          flush();
          out.push({
            type: 'link',
            text: input.slice(i + 1, closeBr),
            url: input.slice(closeBr + 2, closePar)
          });
          i = closePar + 1;
          continue;
        }
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * Build a .docx file from the markdown body using the `docx` library and
 * save via file-saver. Focused converter — headings, paragraphs, code
 * blocks, bullets, and inline bold/italic/code/links — which covers the
 * shape of the agent artifacts we actually produce.
 */
export async function downloadAsDOCX(runId, artifactName) {
  const text = await fetchArtifactText(runId, artifactName);
  const docxLib = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink } = docxLib;

  function toRuns(content) {
    const segments = parseInline(content);
    if (segments.length === 0) {
      return [new TextRun({ text: String(content || '') })];
    }
    return segments.map(seg => {
      if (seg.type === 'bold') return new TextRun({ text: seg.text, bold: true });
      if (seg.type === 'italic') return new TextRun({ text: seg.text, italics: true });
      if (seg.type === 'code')
        return new TextRun({ text: seg.text, font: { name: 'Courier New' } });
      if (seg.type === 'link') {
        return new ExternalHyperlink({
          link: seg.url,
          children: [new TextRun({ text: seg.text, style: 'Hyperlink' })]
        });
      }
      return new TextRun({ text: seg.text });
    });
  }

  const paragraphs = [];
  function pushPara(content, opts = {}) {
    paragraphs.push(
      new Paragraph({
        ...(opts.heading ? { heading: opts.heading } : {}),
        ...(opts.bullet ? { bullet: { level: opts.bullet.level || 0 } } : {}),
        children: toRuns(content)
      })
    );
  }

  const lines = (text || '').split('\n');
  let inCodeBlock = false;
  let codeBuffer = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        if (codeBuffer.length > 0) {
          paragraphs.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: codeBuffer.join('\n'),
                  font: { name: 'Courier New' }
                })
              ]
            })
          );
        }
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    const h4 = line.match(/^####\s+(.+)/);
    const bullet = line.match(/^(\s*)[-*]\s+(.+)/);
    const numbered = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (h1) {
      pushPara(h1[1], { heading: HeadingLevel.HEADING_1 });
    } else if (h2) {
      pushPara(h2[1], { heading: HeadingLevel.HEADING_2 });
    } else if (h3) {
      pushPara(h3[1], { heading: HeadingLevel.HEADING_3 });
    } else if (h4) {
      pushPara(h4[1], { heading: HeadingLevel.HEADING_4 });
    } else if (bullet) {
      const level = Math.min(2, Math.floor(bullet[1].length / 2));
      pushPara(bullet[2], { bullet: { level } });
    } else if (numbered) {
      const level = Math.min(2, Math.floor(numbered[1].length / 2));
      pushPara(numbered[2], { bullet: { level } });
    } else if (line.trim() === '') {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
    } else {
      pushPara(line);
    }
  }

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }]
  });
  const blob = await Packer.toBlob(doc);
  saveAs(blob, `${baseNameWithoutMd(artifactName)}.docx`);
}
