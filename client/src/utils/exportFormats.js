import writeXlsxFile from 'write-excel-file';
import { Document, Paragraph, TextRun, HeadingLevel } from 'docx';
import PptxGenJS from 'pptxgenjs';

/**
 * Parse inline markdown formatting (bold, italic, code) within a text line
 * Returns array of text segments with formatting information
 */
const parseInlineMarkdown = text => {
  if (!text || typeof text !== 'string') return [{ text: '', format: {} }];

  const segments = [];
  let currentPos = 0;

  // Match: ***bold+italic***, **bold**, *italic*, `code`
  const inlineRegex = /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;

  let match;
  while ((match = inlineRegex.exec(text)) !== null) {
    // Add plain text before the match
    if (match.index > currentPos) {
      const plainText = text.slice(currentPos, match.index);
      if (plainText) {
        segments.push({ text: plainText, format: {} });
      }
    }

    // Add formatted text based on the match
    if (match[2]) {
      // ***bold+italic***
      segments.push({ text: match[2], format: { bold: true, italic: true } });
    } else if (match[3]) {
      // **bold**
      segments.push({ text: match[3], format: { bold: true } });
    } else if (match[4]) {
      // *italic*
      segments.push({ text: match[4], format: { italic: true } });
    } else if (match[5]) {
      // `code`
      segments.push({ text: match[5], format: { code: true } });
    }

    currentPos = match.index + match[0].length;
  }

  // Add remaining plain text
  if (currentPos < text.length) {
    const remainingText = text.slice(currentPos);
    if (remainingText) {
      segments.push({ text: remainingText, format: {} });
    }
  }

  return segments.length > 0 ? segments : [{ text, format: {} }];
};

/**
 * Parse markdown content into structured blocks
 * Returns array of blocks with type and content information
 * Supports: headings, lists, paragraphs with inline formatting
 * Preserves newlines and paragraph breaks for readability
 */
const parseMarkdown = content => {
  if (!content || typeof content !== 'string') return [];

  const blocks = [];
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Empty lines create line breaks (preserve them for readability)
    if (!trimmedLine) {
      // Add empty paragraph for spacing
      blocks.push({
        type: 'paragraph',
        segments: [{ text: '', format: {} }]
      });
      i++;
      continue;
    }

    // Headings: # H1, ## H2, ### H3, etc.
    const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      blocks.push({
        type: 'heading',
        level,
        segments: parseInlineMarkdown(text)
      });
      i++;
      continue;
    }

    // Unordered list: *, -, +
    const unorderedListMatch = trimmedLine.match(/^[\*\-\+]\s+(.+)$/);
    if (unorderedListMatch) {
      const listItems = [];
      while (i < lines.length) {
        const listLine = lines[i].trim();
        const listMatch = listLine.match(/^[\*\-\+]\s+(.+)$/);
        if (listMatch) {
          listItems.push({
            segments: parseInlineMarkdown(listMatch[1])
          });
          i++;
        } else if (!listLine) {
          // Empty line ends the list
          break;
        } else {
          // Non-list line ends the list
          break;
        }
      }
      blocks.push({
        type: 'list',
        ordered: false,
        items: listItems
      });
      continue;
    }

    // Ordered list: 1., 2., etc.
    const orderedListMatch = trimmedLine.match(/^\d+\.\s+(.+)$/);
    if (orderedListMatch) {
      const listItems = [];
      while (i < lines.length) {
        const listLine = lines[i].trim();
        const listMatch = listLine.match(/^\d+\.\s+(.+)$/);
        if (listMatch) {
          listItems.push({
            segments: parseInlineMarkdown(listMatch[1])
          });
          i++;
        } else if (!listLine) {
          // Empty line ends the list
          break;
        } else {
          // Non-list line ends the list
          break;
        }
      }
      blocks.push({
        type: 'list',
        ordered: true,
        items: listItems
      });
      continue;
    }

    // Regular paragraph - collect consecutive non-empty lines
    const paragraphLines = [];
    while (i < lines.length) {
      const currentLine = lines[i].trim();
      if (!currentLine) {
        // Empty line ends paragraph
        break;
      }
      // Check if next line is a special format (heading, list)
      if (currentLine.match(/^#{1,6}\s+/)) break;
      if (currentLine.match(/^[\*\-\+]\s+/)) break;
      if (currentLine.match(/^\d+\.\s+/)) break;

      paragraphLines.push(currentLine);
      i++;
    }

    if (paragraphLines.length > 0) {
      // Join lines with space to preserve readability
      const paragraphText = paragraphLines.join(' ');
      blocks.push({
        type: 'paragraph',
        segments: parseInlineMarkdown(paragraphText)
      });
    }
  }

  return blocks;
};

/**
 * Convert parsed markdown blocks to DOCX paragraphs
 */
const markdownToDOCX = blocks => {
  const paragraphs = [];

  blocks.forEach(block => {
    if (block.type === 'heading') {
      // Map heading levels to DOCX heading levels
      const headingLevels = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4,
        5: HeadingLevel.HEADING_5,
        6: HeadingLevel.HEADING_6
      };

      const textRuns = block.segments.map(segment => {
        const options = { text: segment.text };
        if (segment.format.bold) options.bold = true;
        if (segment.format.italic) options.italics = true;
        if (segment.format.code) options.font = 'Courier New';
        return new TextRun(options);
      });

      paragraphs.push(
        new Paragraph({
          children: textRuns,
          heading: headingLevels[block.level] || HeadingLevel.HEADING_6
        })
      );
    } else if (block.type === 'list') {
      // Add list items as paragraphs with bullets/numbering
      block.items.forEach((item, index) => {
        const textRuns = item.segments.map(segment => {
          const options = { text: segment.text };
          if (segment.format.bold) options.bold = true;
          if (segment.format.italic) options.italics = true;
          if (segment.format.code) options.font = 'Courier New';
          return new TextRun(options);
        });

        paragraphs.push(
          new Paragraph({
            children: textRuns,
            bullet: block.ordered ? undefined : { level: 0 },
            numbering: block.ordered
              ? {
                  reference: 'default-numbering',
                  level: 0
                }
              : undefined
          })
        );
      });
    } else if (block.type === 'paragraph') {
      // Check if this is an empty paragraph (line break)
      if (block.segments.length === 1 && block.segments[0].text === '') {
        // Add empty paragraph for spacing
        paragraphs.push(new Paragraph({ text: '' }));
      } else {
        const textRuns = block.segments.map(segment => {
          const options = { text: segment.text };
          if (segment.format.bold) options.bold = true;
          if (segment.format.italic) options.italics = true;
          if (segment.format.code) options.font = 'Courier New';
          return new TextRun(options);
        });

        paragraphs.push(new Paragraph({ children: textRuns }));
      }
    }
  });

  return paragraphs;
};

/**
 * Convert parsed markdown blocks to PPTX rich text
 */
const markdownToPPTX = blocks => {
  const richTextParts = [];

  blocks.forEach((block, blockIndex) => {
    if (block.type === 'heading') {
      // Headings in PPTX - make them bold and larger
      block.segments.forEach(segment => {
        const textObj = {
          text: segment.text,
          bold: true,
          fontSize: Math.max(18, 24 - block.level * 2) // H1=24, H2=22, etc.
        };
        if (segment.format.italic) textObj.italic = true;
        if (segment.format.code) textObj.fontFace = 'Courier New';

        richTextParts.push(textObj);
      });
      richTextParts.push({ text: '\n' });
    } else if (block.type === 'list') {
      // Lists in PPTX
      block.items.forEach((item, itemIndex) => {
        // Add bullet/number
        const bullet = block.ordered ? `${itemIndex + 1}. ` : '• ';
        richTextParts.push({ text: bullet });

        item.segments.forEach(segment => {
          const textObj = { text: segment.text };
          if (segment.format.bold) textObj.bold = true;
          if (segment.format.italic) textObj.italic = true;
          if (segment.format.code) textObj.fontFace = 'Courier New';

          richTextParts.push(textObj);
        });
        richTextParts.push({ text: '\n' });
      });
    } else if (block.type === 'paragraph') {
      // Check if this is an empty paragraph (line break)
      if (block.segments.length === 1 && block.segments[0].text === '') {
        // Add newline for spacing
        richTextParts.push({ text: '\n' });
      } else {
        block.segments.forEach(segment => {
          const textObj = { text: segment.text };
          if (segment.format.bold) textObj.bold = true;
          if (segment.format.italic) textObj.italic = true;
          if (segment.format.code) textObj.fontFace = 'Courier New';

          richTextParts.push(textObj);
        });
        if (blockIndex < blocks.length - 1) {
          richTextParts.push({ text: '\n' });
        }
      }
    }
  });

  return richTextParts;
};

/**
 * Export chat messages to XLSX (Excel) format
 * Creates a spreadsheet with columns: Role, Timestamp, Content
 */
export const exportToXLSX = async (messages, settings, appName, appId, chatId) => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `chat-${appId || 'export'}-${timestamp}.xlsx`;

  // Define header style
  const headerStyle = {
    fontWeight: 'bold',
    backgroundColor: '#E0E0E0'
  };

  // Prepare data rows for write-excel-file
  const data = [
    // Header information
    [{ value: 'Chat Export', span: 3, fontWeight: 'bold' }],
    [{ value: 'App' }, { value: appName, span: 2 }],
    [{ value: 'Date' }, { value: new Date().toLocaleString(), span: 2 }],
    [{ value: '', span: 3 }],
    // Column headers
    [
      { value: 'Role', ...headerStyle },
      { value: 'Timestamp', ...headerStyle },
      { value: 'Content', ...headerStyle }
    ]
  ];

  // Add message rows
  messages.forEach(msg => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';
    const content = msg.content || '';
    data.push([{ value: role }, { value: timestamp }, { value: content }]);
  });

  // Add settings section if available
  if (settings && Object.keys(settings).filter(k => settings[k]).length > 0) {
    data.push([{ value: '', span: 3 }]);
    data.push([{ value: 'Settings', ...headerStyle, span: 3 }]);

    if (settings.model) data.push([{ value: 'Model' }, { value: settings.model, span: 2 }]);
    if (settings.temperature !== undefined)
      data.push([{ value: 'Temperature' }, { value: String(settings.temperature), span: 2 }]);
    if (settings.style) data.push([{ value: 'Style' }, { value: settings.style, span: 2 }]);
    if (settings.outputFormat)
      data.push([{ value: 'Output Format' }, { value: settings.outputFormat, span: 2 }]);
  }

  // Define column widths
  const columns = [{ width: 15 }, { width: 20 }, { width: 80 }];

  // Write XLSX file
  await writeXlsxFile(data, {
    columns,
    fileName: filename
  });

  return { success: true, filename };
};

/**
 * Export chat messages to CSV format
 * Creates a CSV file with columns: Role, Timestamp, Content
 */
export const exportToCSV = async (messages, settings, appName, appId, chatId) => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `chat-${appId || 'export'}-${timestamp}.csv`;

  // Helper function to escape CSV values
  const escapeCSV = value => {
    if (value === null || value === undefined) return '';
    const stringValue = String(value);
    // Escape quotes and wrap in quotes if contains comma, quote, or newline
    if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  };

  // Build CSV content
  const rows = [];

  // Header information
  rows.push(['Chat Export', '', ''].map(escapeCSV).join(','));
  rows.push(['App', appName, ''].map(escapeCSV).join(','));
  rows.push(['Date', new Date().toLocaleString(), ''].map(escapeCSV).join(','));
  rows.push(['', '', ''].map(escapeCSV).join(','));

  // Column headers
  rows.push(['Role', 'Timestamp', 'Content'].map(escapeCSV).join(','));

  // Add message rows
  messages.forEach(msg => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';
    const content = msg.content || '';
    rows.push([role, timestamp, content].map(escapeCSV).join(','));
  });

  // Create CSV content
  const csvContent = rows.join('\n');

  // Download file
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);

  return { success: true, filename };
};

/**
 * Export chat messages to DOCX (Word) format
 * Creates a formatted Word document with the conversation
 */
export const exportToDOCX = async (messages, settings, appName, appId, chatId) => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `chat-${appId || 'export'}-${timestamp}.docx`;

  const children = [];

  // Add title
  children.push(
    new Paragraph({
      text: 'Chat Export',
      heading: HeadingLevel.HEADING_1
    })
  );

  // Add metadata
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'App: ',
          bold: true
        }),
        new TextRun(appName)
      ]
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'Date: ',
          bold: true
        }),
        new TextRun(new Date().toLocaleString())
      ]
    })
  );

  children.push(new Paragraph({ text: '' }));

  // Add messages
  messages.forEach(msg => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const content = msg.content || '';

    // Add role heading
    children.push(
      new Paragraph({
        text: role,
        heading: HeadingLevel.HEADING_2
      })
    );

    // Add timestamp if available
    if (msg.timestamp) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: new Date(msg.timestamp).toLocaleString(),
              italics: true,
              size: 18
            })
          ]
        })
      );
    }

    // Parse markdown and convert to DOCX paragraphs
    const blocks = parseMarkdown(content);
    const parsedParagraphs = markdownToDOCX(blocks);
    children.push(...parsedParagraphs);

    children.push(new Paragraph({ text: '' }));
  });

  // Add settings section if available
  if (settings) {
    children.push(
      new Paragraph({
        text: 'Settings',
        heading: HeadingLevel.HEADING_1
      })
    );

    if (settings.model) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: 'Model: ', bold: true }), new TextRun(settings.model)]
        })
      );
    }

    if (settings.temperature !== undefined) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: 'Temperature: ', bold: true }),
            new TextRun(String(settings.temperature))
          ]
        })
      );
    }

    if (settings.style) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: 'Style: ', bold: true }), new TextRun(settings.style)]
        })
      );
    }

    if (settings.outputFormat) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: 'Output Format: ', bold: true }),
            new TextRun(settings.outputFormat)
          ]
        })
      );
    }
  }

  // Create document with proper numbering support
  const { AlignmentType, convertInchesToTwip } = await import('docx');
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'default-numbering',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) }
                }
              }
            }
          ]
        }
      ]
    },
    sections: [
      {
        children
      }
    ]
  });

  // Use docx Packer to generate blob
  const { Packer } = await import('docx');
  const blob = await Packer.toBlob(doc);

  // Download file
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);

  return { success: true, filename };
};

/**
 * Export chat messages to TXT (plain text) format
 * Creates a simple text file with the conversation
 */
export const exportToTXT = (messages, settings, appName, appId, chatId) => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `chat-${appId || 'export'}-${timestamp}.txt`;

  let content = 'Chat Export\n';
  content += '='.repeat(50) + '\n\n';
  content += `App: ${appName}\n`;
  content += `Date: ${new Date().toLocaleString()}\n\n`;
  content += '='.repeat(50) + '\n\n';

  // Add messages
  messages.forEach(msg => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';

    content += `[${role}]`;
    if (timestamp) {
      content += ` - ${timestamp}`;
    }
    content += '\n';
    content += '-'.repeat(50) + '\n';
    content += (msg.content || '') + '\n\n';
  });

  // Add settings section
  if (settings) {
    content += '='.repeat(50) + '\n';
    content += 'Settings\n';
    content += '='.repeat(50) + '\n\n';

    if (settings.model) content += `Model: ${settings.model}\n`;
    if (settings.temperature !== undefined) content += `Temperature: ${settings.temperature}\n`;
    if (settings.style) content += `Style: ${settings.style}\n`;
    if (settings.outputFormat) content += `Output Format: ${settings.outputFormat}\n`;
  }

  // Create blob and download
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);

  return { success: true, filename };
};

/**
 * Export chat messages to PPTX (PowerPoint) format
 * Creates a presentation with each message on a separate slide
 */
export const exportToPPTX = async (messages, settings, appName, appId, chatId) => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `chat-${appId || 'export'}-${timestamp}.pptx`;

  const pres = new PptxGenJS();

  // Title slide
  const titleSlide = pres.addSlide();
  titleSlide.background = { color: '4F46E5' };

  titleSlide.addText('Chat Export', {
    x: 0.5,
    y: 1.5,
    w: 9,
    h: 1,
    fontSize: 44,
    bold: true,
    color: 'FFFFFF',
    align: 'center'
  });

  titleSlide.addText(`App: ${appName}`, {
    x: 0.5,
    y: 3,
    w: 9,
    h: 0.5,
    fontSize: 20,
    color: 'FFFFFF',
    align: 'center'
  });

  titleSlide.addText(`Date: ${new Date().toLocaleString()}`, {
    x: 0.5,
    y: 3.5,
    w: 9,
    h: 0.5,
    fontSize: 16,
    color: 'FFFFFF',
    align: 'center'
  });

  // Message slides
  messages.forEach((msg, index) => {
    const slide = pres.addSlide();
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const backgroundColor = msg.role === 'user' ? 'F3F4F6' : 'FFFFFF';

    slide.background = { color: backgroundColor };

    // Add role header
    slide.addText(role, {
      x: 0.5,
      y: 0.5,
      w: 9,
      h: 0.5,
      fontSize: 24,
      bold: true,
      color: '1F2937'
    });

    // Add timestamp if available
    if (msg.timestamp) {
      slide.addText(new Date(msg.timestamp).toLocaleString(), {
        x: 0.5,
        y: 1.0,
        w: 9,
        h: 0.3,
        fontSize: 12,
        color: '6B7280',
        italic: true
      });
    }

    // Add content with markdown formatting preserved
    const content = msg.content || '';

    // Parse markdown and convert to PPTX rich text
    const blocks = parseMarkdown(content);
    const richText = markdownToPPTX(blocks);

    slide.addText(richText, {
      x: 0.5,
      y: 1.5,
      w: 9,
      h: 4.5,
      fontSize: 14,
      color: '111827',
      valign: 'top', // Align text to top
      wrap: true, // Enable text wrapping
      valign: 'top'
    });

    // Add slide number
    slide.addText(`${index + 1} / ${messages.length}`, {
      x: 8.5,
      y: 6.8,
      w: 1,
      h: 0.3,
      fontSize: 10,
      color: '9CA3AF',
      align: 'right'
    });
  });

  // Settings slide
  if (settings && Object.keys(settings).length > 0) {
    const settingsSlide = pres.addSlide();
    settingsSlide.background = { color: 'F9FAFB' };

    settingsSlide.addText('Settings', {
      x: 0.5,
      y: 0.5,
      w: 9,
      h: 0.5,
      fontSize: 24,
      bold: true,
      color: '1F2937'
    });

    let settingsText = '';
    if (settings.model) settingsText += `Model: ${settings.model}\n`;
    if (settings.temperature !== undefined)
      settingsText += `Temperature: ${settings.temperature}\n`;
    if (settings.style) settingsText += `Style: ${settings.style}\n`;
    if (settings.outputFormat) settingsText += `Output Format: ${settings.outputFormat}\n`;

    settingsSlide.addText(settingsText, {
      x: 0.5,
      y: 1.5,
      w: 9,
      h: 4,
      fontSize: 16,
      color: '374151',
      valign: 'top'
    });
  }

  // Write file
  await pres.writeFile({ fileName: filename });

  return { success: true, filename };
};
