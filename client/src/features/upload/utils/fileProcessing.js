// Shared file processing utilities for upload components

// Lazy load PDF.js only when needed
export const loadPdfjs = async () => {
  const pdfjsLib = await import('pdfjs-dist');
  // Configure PDF.js worker
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  return pdfjsLib;
};

// Lazy load Mammoth only when needed
export const loadMammoth = async () => {
  const mammoth = await import('mammoth');
  return mammoth;
};

// Lazy load MSGReader only when needed
export const loadMsgReader = async () => {
  const MsgReader = await import('@kenjiuno/msgreader');
  return MsgReader;
};

// Lazy load JSZip only when needed for OpenOffice formats
export const loadJSZip = async () => {
  const JSZip = await import('jszip');
  return JSZip.default;
};

// Supported MIME types
export const SUPPORTED_TEXT_FORMATS = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'text/xml',
  'message/rfc822', // EML
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
  'application/vnd.ms-outlook', // MSG (Windows)
  'application/x-msg', // MSG (alternative MIME type used by some systems)
  'application/vnd.oasis.opendocument.text', // ODT
  'application/vnd.oasis.opendocument.spreadsheet', // ODS
  'application/vnd.oasis.opendocument.presentation' // ODP
];

// File extension mapping for better OS compatibility (especially macOS)
export const MIME_TO_EXTENSION = {
  // Image formats
  'image/jpeg': '.jpeg,.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/tiff': '.tiff,.tif',
  'image/tif': '.tif',
  // Audio formats
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
  // Document formats
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'text/html': '.html',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'text/xml': '.xml',
  'message/rfc822': '.eml',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-outlook': '.msg',
  'application/x-msg': '.msg',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp'
};

// Convert MIME types array to accept string with both MIME types and extensions
export const formatAcceptAttribute = mimeTypes => {
  const acceptValues = [];
  mimeTypes.forEach(mimeType => {
    // Add the MIME type
    acceptValues.push(mimeType);
    // Add the file extension(s) if available
    const extension = MIME_TO_EXTENSION[mimeType];
    if (extension) {
      // Handle comma-separated extensions (e.g., ".jpeg,.jpg")
      const extensions = extension.split(',');
      acceptValues.push(...extensions);
    }
  });
  return acceptValues;
};

// Get display type for a MIME type
export const getFileTypeDisplay = mimeType => {
  switch (mimeType) {
    case 'text/plain':
      return 'TXT';
    case 'text/markdown':
      return 'MD';
    case 'text/csv':
      return 'CSV';
    case 'application/json':
      return 'JSON';
    case 'text/html':
      return 'HTML';
    case 'text/css':
      return 'CSS';
    case 'text/javascript':
    case 'application/javascript':
      return 'JS';
    case 'text/xml':
      return 'XML';
    case 'message/rfc822':
      return 'EML';
    case 'application/pdf':
      return 'PDF';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'DOCX';
    case 'application/vnd.ms-outlook':
      return 'MSG';
    case 'application/vnd.oasis.opendocument.text':
      return 'ODT';
    case 'application/vnd.oasis.opendocument.spreadsheet':
      return 'ODS';
    case 'application/vnd.oasis.opendocument.presentation':
      return 'ODP';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'MP3';
    case 'audio/wav':
      return 'WAV';
    case 'audio/flac':
      return 'FLAC';
    case 'audio/ogg':
      return 'OGG';
    case 'image/tiff':
    case 'image/tif':
      return 'TIFF';
    default:
      return 'FILE';
  }
};

// Convert MIME types to display format list
export const formatMimeTypesToDisplay = mimeTypes => {
  const displayFormats = mimeTypes.map(getFileTypeDisplay);
  return [...new Set(displayFormats)].join(', ');
};

// Read text file
export const readTextFile = file => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('read-error'));
    reader.readAsText(file);
  });
};

// Process PDF file
export const processPdfFile = async file => {
  const arrayBuffer = await file.arrayBuffer();
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
  let textContent = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContentPage = await page.getTextContent();
    const textItems = textContentPage.items.map(item => item.str).join(' ');
    textContent += textItems + '\n';
  }

  return textContent.trim();
};

// Process DOCX file
export const processDocxFile = async file => {
  const arrayBuffer = await file.arrayBuffer();
  const mammoth = await loadMammoth();
  const result = await mammoth.convertToHtml({ arrayBuffer });

  // Extract plain text from HTML for better readability
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = result.value;
  return tempDiv.textContent || tempDiv.innerText || '';
};

// Process MSG file
export const processMsgFile = async file => {
  const arrayBuffer = await file.arrayBuffer();
  const MsgReader = await loadMsgReader();
  const msgReader = new MsgReader.default(arrayBuffer);
  const fileData = msgReader.getFileData();

  // Extract text content from MSG file
  let textContent = '';
  if (fileData.subject) {
    textContent += `Subject: ${fileData.subject}\n\n`;
  }
  if (fileData.senderName) {
    textContent += `From: ${fileData.senderName}`;
    if (fileData.senderEmail) {
      textContent += ` <${fileData.senderEmail}>`;
    }
    textContent += '\n';
  }
  if (fileData.recipients && fileData.recipients.length > 0) {
    textContent += `To: ${fileData.recipients.map(r => r.name || r.email).join(', ')}\n`;
  }
  if (fileData.body) {
    textContent += `\n${fileData.body}`;
  }

  return textContent.trim();
};

// Process OpenOffice/LibreOffice file
export const processOpenOfficeFile = async file => {
  const arrayBuffer = await file.arrayBuffer();
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Extract content.xml which contains the text content
  const contentXml = await zip.file('content.xml')?.async('string');

  if (contentXml) {
    // Parse XML and extract text content
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(contentXml, 'text/xml');

    // Extract all text nodes
    const extractText = node => {
      let text = '';
      if (node.nodeType === Node.TEXT_NODE) {
        text = node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Add line breaks for paragraphs
        if (node.nodeName === 'text:p' || node.nodeName === 'text:h') {
          text = '\n';
        }
        for (const child of node.childNodes) {
          text += extractText(child);
        }
        if (node.nodeName === 'text:p' || node.nodeName === 'text:h') {
          text += '\n';
        }
      }
      return text;
    };

    return extractText(xmlDoc.documentElement).trim();
  } else {
    throw new Error('Unable to extract content from OpenOffice document');
  }
};

// Main document processing function
export const processDocumentFile = async file => {
  let content = '';

  // Get file extension as fallback for MIME type detection
  const fileExtension = '.' + file.name.split('.').pop().toLowerCase();

  // Determine processing method based on MIME type or file extension
  if (file.type === 'application/pdf' || fileExtension === '.pdf') {
    content = await processPdfFile(file);
  } else if (
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileExtension === '.docx'
  ) {
    content = await processDocxFile(file);
  } else if (
    file.type === 'application/vnd.ms-outlook' ||
    file.type === 'application/x-msg' ||
    fileExtension === '.msg'
  ) {
    content = await processMsgFile(file);
  } else if (
    file.type === 'application/vnd.oasis.opendocument.text' ||
    file.type === 'application/vnd.oasis.opendocument.spreadsheet' ||
    file.type === 'application/vnd.oasis.opendocument.presentation' ||
    fileExtension === '.odt' ||
    fileExtension === '.ods' ||
    fileExtension === '.odp'
  ) {
    content = await processOpenOfficeFile(file);
  } else {
    // Default: read as text file
    content = await readTextFile(file);
  }

  return content;
};
