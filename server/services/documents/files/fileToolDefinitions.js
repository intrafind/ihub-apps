// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Definitions of the tools the `files` system skill brings (see
 * `server/systemSkills/files`). Plain data: the handlers live in
 * `fileTools.js` and are loaded when a tool runs.
 */

export const CREATE_FILE_TOOL = {
  id: 'create_file',
  name: { en: 'Create file', de: 'Datei erstellen' },
  description: {
    en: 'Create a text file — source code (JavaScript, TypeScript, Python, Java, SQL, shell, CSS, …), JSON, YAML, CSV, Markdown or plain text — and give it to the user as a download. The extension of "name" decides the file type; a path such as "src/index.ts" keeps its folders when the files are packed into a ZIP. Call it once per file. The user sees a download card in the chat, so do not paste the content again or add a link — name the file instead. Activate the "files" skill first for guidance.',
    de: 'Erstellt eine Textdatei – Quellcode (JavaScript, TypeScript, Python, Java, SQL, Shell, CSS, …), JSON, YAML, CSV, Markdown oder reinen Text – und stellt sie dem Benutzer als Download bereit. Die Endung von "name" bestimmt den Dateityp; ein Pfad wie "src/index.ts" behält seine Ordner, wenn die Dateien in ein ZIP gepackt werden. Einmal pro Datei aufrufen. Der Benutzer sieht im Chat eine Download-Karte – den Inhalt nicht noch einmal einfügen und keinen Link angeben, stattdessen den Dateinamen nennen. Für Hinweise zuerst den Skill "files" aktivieren.'
  },
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'File name with extension, optionally with folders: "report.csv", "src/utils/date.ts", "Dockerfile".'
      },
      content: {
        type: 'string',
        description: 'The complete content of the file, as UTF-8 text.'
      },
      mimeType: {
        type: 'string',
        description:
          'Optional media type, used only when the extension does not tell, e.g. "text/x-python" for a script without extension.'
      }
    },
    required: ['name', 'content']
  }
};

export const CREATE_ZIP_TOOL = {
  id: 'create_zip',
  name: { en: 'Create ZIP archive', de: 'ZIP-Archiv erstellen' },
  description: {
    en: 'Pack files into one ZIP archive and give it to the user as a download. The archive can hold new files ("files": name with folders, and text content) and files already created in this chat ("include": their names or ids, or "includeAll": true for every file created in this chat). Use it when the user asks for a project, several files, or "everything" as a ZIP. Folders in the names are kept. The user sees a download card in the chat — name the archive in your answer instead of adding a link.',
    de: 'Packt Dateien in ein ZIP-Archiv und stellt es dem Benutzer als Download bereit. Das Archiv kann neue Dateien enthalten ("files": Name mit Ordnern und Textinhalt) und Dateien, die in diesem Chat bereits erstellt wurden ("include": deren Namen oder IDs, oder "includeAll": true für alle in diesem Chat erstellten Dateien). Verwenden, wenn der Benutzer ein Projekt, mehrere Dateien oder "alles" als ZIP möchte. Ordner in den Namen bleiben erhalten. Der Benutzer sieht im Chat eine Download-Karte – den Archivnamen nennen statt einen Link anzugeben.'
  },
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Archive file name without extension, e.g. "todo-app".'
      },
      files: {
        type: 'array',
        description: 'New files to put in the archive.',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Path inside the archive, e.g. "src/index.ts" or "README.md".'
            },
            content: { type: 'string', description: 'The complete file content, as UTF-8 text.' }
          },
          required: ['name', 'content']
        }
      },
      include: {
        type: 'array',
        description:
          'Files already created in this chat to add: their names (e.g. "src/index.ts") or ids.',
        items: { type: 'string' }
      },
      includeAll: {
        type: 'boolean',
        description:
          'Add every file created in this chat (generated documents and text files; not pictures or other archives). A newer file replaces an older one of the same name.'
      }
    },
    required: ['filename']
  }
};
