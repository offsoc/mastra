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

// Helper function to recursively scan directory and generate flat list of paths
async function scanDocs(baseDir: string): Promise<string[]> {
  const allPaths: string[] = [];

  async function scan(currentPath: string, relativePath: string = '') {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relPath = path.join(relativePath, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath, relPath);
        // Add directory path with trailing slash
        allPaths.push(relPath + '/');
      } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
        allPaths.push(relPath);
      }
    }
  }

  await scan(baseDir);
  return allPaths.sort(); // Sort paths for consistent ordering
}

// Helper function to read MDX files from a path
async function readMdxContent(docPath: string): Promise<string> {
  const fullPath = path.join(docsBaseDir, docPath);
  const stats = await fs.stat(fullPath);

  if (stats.isDirectory()) {
    // If it's a directory (ends with /), combine all MDX files
    const files = await fs.readdir(fullPath);
    const mdxFiles = files.filter(file => file.endsWith('.mdx')).sort(); // Sort for consistent ordering
    let content = '';

    for (const file of mdxFiles) {
      const filePath = path.join(fullPath, file);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      content += `\n\n${fileContent}`;
    }

    return content;
  } else {
    // If it's a file, just read it
    return fs.readFile(fullPath, 'utf-8');
  }
}

// Initialize paths and create Zod enum schema
const docPaths = await scanDocs(docsBaseDir);
if (docPaths.length === 0) {
  throw new Error('No documentation files found');
}

console.error(docPaths);

// Create the Zod enum schema from available paths
const pathSchema = z.enum([docPaths[0], ...docPaths.slice(1)] as [string, ...string[]]);

server.addTool({
  name: 'listDocsPaths',
  description: 'List all available documentation paths. Paths ending with / are directories containing multiple docs.',
  parameters: z.object({}),
  execute: async () => {
    const directories = docPaths.filter(p => p.endsWith('/'));
    const files = docPaths.filter(p => !p.endsWith('/'));

    return [
      'Available documentation paths:',
      '',
      'Directories (contain multiple docs):',
      ...directories.map(d => `- ${d}`),
      '',
      'Individual files:',
      ...files.map(f => `- ${f}`),
    ].join('\n');
  },
});

server.addTool({
  name: 'mastraDocs',
  description:
    'Get Mastra.ai documentation for a specific path. Pick a file for specific docs or a directory for all docs in the directory.',
  parameters: z.object({
    path: pathSchema.describe(
      'The documentation path to fetch. Can be a file path or directory path (with trailing slash)',
    ),
  }),
  execute: async args => {
    console.error(args);
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
