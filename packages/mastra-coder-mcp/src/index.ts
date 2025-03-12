import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const server = new FastMCP({
  name: 'Mastra Documentation Server',
  version: '1.0.0',
});

const docsBaseDir = path.join(__dirname, '../.docs/raw/');

// Helper function to list contents of a directory
async function listDirContents(dirPath: string): Promise<{ dirs: string[]; files: string[] }> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name + '/');
    } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
      files.push(entry.name);
    }
  }

  return {
    dirs: dirs.sort(),
    files: files.sort(),
  };
}

// Helper function to read MDX files from a path
async function readMdxContent(docPath: string): Promise<string> {
  const fullPath = path.join(docsBaseDir, docPath);

  // Handle directory listing
  if (docPath.endsWith('/*')) {
    const dirPath = docPath.slice(0, -2);
    const { files } = await listDirContents(path.join(docsBaseDir, dirPath));
    let content = '';

    for (const file of files) {
      console.error(`reading ${file}`);
      const filePath = path.join(docsBaseDir, dirPath, file);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      content += `\n\n${fileContent}`;
    }

    return content;
  }

  // Check if path exists
  try {
    const stats = await fs.stat(fullPath);

    if (stats.isDirectory()) {
      const { dirs, files } = await listDirContents(fullPath);
      const message = [
        `This is a directory. Available contents:`,
        '',
        'Directories:',
        ...dirs.map(d => `- ${d}`),
        '',
        'Files:',
        ...files.map(f => `- ${f}`),
        '',
        'To get all docs in this directory, append /* to your path.',
      ].join('\n');
      console.error(message);
      return message;
    }

    // If it's a file, just read it
    return fs.readFile(fullPath, 'utf-8');
  } catch {
    throw new Error(`Path not found: ${docPath}`);
  }
}

// Get initial directory listing for the description
const { dirs, files } = await listDirContents(docsBaseDir);
const availablePaths = [
  'Available top-level paths:',
  '',
  'Directories (append /* to get all docs in directory):',
  ...dirs.map(d => `- ${d}`),
  '',
  'Files:',
  ...files.map(f => `- ${f}`),
].join('\n');

console.error(availablePaths);

server.addTool({
  name: 'mastraDocs',
  description:
    'Get Mastra.ai documentation. For directories, you can either request the directory path to see its contents, ' +
    'or append /* to get all docs in that directory.\n\n' +
    availablePaths,
  parameters: z.object({
    path: z.string().describe('The documentation path to fetch'),
  }),
  execute: async args => {
    console.error('mastraDocs', args);
    try {
      const content = await readMdxContent(args.path);
      return content;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to fetch documentation: ${error.message}`);
      }
      throw error;
    }
  },
});

void server.start({
  transportType: 'stdio',
});
