import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.error('Starting Mastra Documentation Server...');
console.error('Docs base dir:', path.join(__dirname, '../.docs/raw/'));

const server = new FastMCP({
  name: 'Mastra Documentation Server',
  version: '1.0.0',
});

const docsBaseDir = path.join(__dirname, '../.docs/raw/');

// Helper function to list contents of a directory
async function listDirContents(dirPath: string): Promise<{ dirs: string[]; files: string[] }> {
  console.error('Listing contents of:', dirPath);
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

  console.error('Found directories:', dirs);
  console.error('Found files:', files);

  return {
    dirs: dirs.sort(),
    files: files.sort(),
  };
}

// Helper function to read MDX files from a path
async function readMdxContent(docPath: string): Promise<string> {
  console.error('Reading content for path:', docPath);
  const fullPath = path.join(docsBaseDir, docPath);
  console.error('Full path:', fullPath);

  // Check if path exists
  try {
    const stats = await fs.stat(fullPath);
    console.error('Path exists, isDirectory:', stats.isDirectory());

    if (stats.isDirectory()) {
      const { dirs, files } = await listDirContents(fullPath);
      const dirListing = [
        `Directory contents of ${docPath}:`,
        '',
        dirs.length > 0 ? 'Subdirectories:' : 'No subdirectories.',
        ...dirs.map(d => `- ${d}`),
        '',
        files.length > 0 ? 'Files in this directory:' : 'No files in this directory.',
        ...files.map(f => `- ${f}`),
        '',
        '---',
        '',
        'Contents of all files in this directory:',
        '',
      ].join('\n');

      // Append all file contents
      console.error(`Reading ${files.length} files from directory`);
      let fileContents = '';
      for (const file of files) {
        console.error(`Reading file: ${file}`);
        const filePath = path.join(fullPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        fileContents += `\n\n# ${file}\n\n${content}`;
      }

      return dirListing + fileContents;
    }

    // If it's a file, just read it
    console.error('Reading single file');
    return fs.readFile(fullPath, 'utf-8');
  } catch (error) {
    console.error('Error reading path:', error);
    throw new Error(`Path not found: ${docPath}`);
  }
}

// Get initial directory listing for the description
console.error('Getting initial directory listing...');
const { dirs, files } = await listDirContents(docsBaseDir);

// Get reference directory contents if it exists
let referenceDirs: string[] = [];
if (dirs.includes('reference/')) {
  console.error('Getting reference directory contents...');
  const { dirs: refDirs } = await listDirContents(path.join(docsBaseDir, 'reference'));
  referenceDirs = refDirs.map(d => `reference/${d}`);
  console.error('Reference subdirectories:', referenceDirs);
}

const availablePaths = [
  'Available top-level paths:',
  '',
  'Directories:',
  ...dirs.map(d => `- ${d}`),
  '',
  referenceDirs.length > 0 ? 'Reference subdirectories:' : '',
  ...referenceDirs.map(d => `- ${d}`),
  '',
  'Files:',
  ...files.map(f => `- ${f}`),
]
  .filter(Boolean)
  .join('\n');

console.error('Initial directory listing complete');
console.error(availablePaths);

server.addTool({
  name: 'mastraDocs',
  description:
    'Get Mastra.ai documentation. Request a path to explore the docs. Reference directories contain API documentation. Other directories contain guides and examples. The user doesn\'t know about files and directories. This is your internal knowledgebase the user can\'t see directly. If the user wants to know about a specific feature check general docs as well as reference docs for that feature. For example with evals check in evals/ and in reference/evals/. Provide code examples so the user understands. If packages need to be installed provide the pnpm command to install them, for example if you see `import x from "@mastra/x"` then tell the user that package must be installed to use it and provide the command. If you build a URL from the path, only paths ending in .mdx exist. For example with evals: https://mastra.ai/docs/evals/ does not exist but https://mastra.ai/docs/evals/00-overview does.',

  parameters: z.object({
    path: z.string().describe(`The documentation path to fetch\nAvailable paths:\n${availablePaths}`),
  }),
  execute: async args => {
    console.error('mastraDocs tool called with args:', args);
    try {
      const content = await readMdxContent(args.path);
      console.error('Successfully read content, length:', content.length);
      return content;
    } catch (error) {
      console.error('Error in mastraDocs tool:', error);
      if (error instanceof Error) {
        throw new Error(`Failed to fetch documentation: ${error.message}`);
      }
      throw error;
    }
  },
});

console.error('Starting server...');
void server.start({
  transportType: 'stdio',
});
