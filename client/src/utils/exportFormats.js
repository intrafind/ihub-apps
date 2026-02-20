import writeXlsxFile from 'write-excel-file';
import { Document, Paragraph, TextRun, HeadingLevel } from 'docx';
import PptxGenJS from 'pptxgenjs';

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

    // Add content (split by lines)
    const lines = content.split('\n');
    lines.forEach(line => {
      children.push(new Paragraph({ text: line }));
    });

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

  // Create document
  const doc = new Document({
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

    // Add content
    const content = msg.content || '';
    const maxLength = 800; // Limit content length per slide
    const truncatedContent =
      content.length > maxLength ? content.slice(0, maxLength) + '...' : content;

    slide.addText(truncatedContent, {
      x: 0.5,
      y: 1.5,
      w: 9,
      h: 4.5,
      fontSize: 14,
      color: '111827',
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
