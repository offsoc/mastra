import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { blogTool } from './tools/blog';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// console.error('Starting Mastra Documentation Server...');
// console.error('Docs base dir:', path.join(__dirname, '../.docs/raw/'));

const server = new FastMCP({
  name: 'Mastra Documentation Server',
  version: '1.0.0',
});

const docsBaseDir = path.join(__dirname, '../.docs/raw/');

// Helper function to list contents of a directory
async function listDirContents(dirPath: string): Promise<{ dirs: string[]; files: string[] }> {
  // console.error('Listing contents of:', dirPath);
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

  // console.error('Found directories:', dirs);
  // console.error('Found files:', files);

  return {
    dirs: dirs.sort(),
    files: files.sort(),
  };
}

// Helper function to read MDX files from a path
async function readMdxContent(docPath: string): Promise<string> {
  // console.error('Reading content for path:', docPath);
  const fullPath = path.join(docsBaseDir, docPath);
  // console.error('Full path:', fullPath);

  // Check if path exists
  try {
    const stats = await fs.stat(fullPath);
    // console.error('Path exists, isDirectory:', stats.isDirectory());

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
      // console.error(`Reading ${files.length} files from directory`);
      let fileContents = '';
      for (const file of files) {
        // console.error(`Reading file: ${file}`);
        const filePath = path.join(fullPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        fileContents += `\n\n# ${file}\n\n${content}`;
      }

      return dirListing + fileContents;
    }

    // If it's a file, just read it
    // console.error('Reading single file');
    return fs.readFile(fullPath, 'utf-8');
  } catch (error) {
    console.error('Error reading path:', error);
    throw new Error(`Path not found: ${docPath}`);
  }
}

// Get initial directory listing for the description
// console.error('Getting initial directory listing...');
const { dirs, files } = await listDirContents(docsBaseDir);

// Get reference directory contents if it exists
let referenceDirs: string[] = [];
if (dirs.includes('reference/')) {
  // console.error('Getting reference directory contents...');
  const { dirs: refDirs } = await listDirContents(path.join(docsBaseDir, 'reference'));
  referenceDirs = refDirs.map(d => `reference/${d}`);
  // console.error('Reference subdirectories:', referenceDirs);
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

// console.error('Initial directory listing complete');
// console.error(availablePaths);

// Helper function to find nearest existing directory and its contents
async function findNearestDirectory(docPath: string): Promise<string> {
  // Split path into parts and try each parent directory
  const parts = docPath.split('/');

  while (parts.length > 0) {
    const testPath = parts.join('/');
    try {
      const fullPath = path.join(docsBaseDir, testPath);
      const stats = await fs.stat(fullPath);

      if (stats.isDirectory()) {
        const { dirs, files } = await listDirContents(fullPath);
        return [
          `Path "${docPath}" not found.`,
          `Here are the available paths in "${testPath}":`,
          '',
          dirs.length > 0 ? 'Directories:' : 'No subdirectories.',
          ...dirs.map(d => `- ${testPath}/${d}`),
          '',
          files.length > 0 ? 'Files:' : 'No files.',
          ...files.map(f => `- ${testPath}/${f}`),
        ].join('\n');
      }
    } catch {
      // Directory doesn't exist, try parent
    }
    parts.pop();
  }

  // If no parent directories found, return root listing
  return [`Path "${docPath}" not found.`, 'Here are all available paths:', '', availablePaths].join('\n');
}

// Add tools
server.addTool(blogTool);

server.addTool({
  name: 'mastraDocs',
  description:
    'Get Mastra.ai documentation. Request paths to explore the docs. References contain API docs. Other paths contain guides. The user doesn\'t know about files and directories. This is your internal knowledge the user can\'t read. If the user asks about a feature check general docs as well as reference docs for that feature. Ex: with evals check in evals/ and in reference/evals/. Provide code examples so the user understands. If you build a URL from the path, only paths ending in .mdx exist. Note that docs about MCP are currently in reference/tools/. IMPORTANT: Be concise with your answers. The user will ask for more info. If packages need to be installed, provide the pnpm command to install them. Ex. if you see `import { X } from "@mastra/$PACKAGE_NAME"` in an example, show an install command. Always install latest tag, not alpha unless requested. If you scaffold a new project it may be in a subdir',

  parameters: z.object({
    paths: z
      .array(z.string())
      .min(1)
      .describe(`One or more documentation paths to fetch\nAvailable paths:\n${availablePaths}`),
  }),
  execute: async args => {
    try {
      const results = await Promise.all(
        args.paths.map(async path => {
          try {
            const content = await readMdxContent(path);
            return {
              path,
              content,
              error: null,
            };
          } catch (error) {
            if (error instanceof Error && error.message.includes('Path not found')) {
              const suggestions = await findNearestDirectory(path);
              return {
                path,
                content: null,
                error: suggestions,
              };
            }
            return {
              path,
              content: null,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        }),
      );

      // Format the results
      const output = results
        .map(result => {
          if (result.error) {
            return `## ${result.path}\n\n${result.error}\n\n---\n`;
          }
          return `## ${result.path}\n\n${result.content}\n\n---\n`;
        })
        .join('\n');

      return output;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to fetch documentation: ${error.message}`);
      }
      throw error;
    }
  },
});

// Helper function to list code examples
async function listCodeExamples(): Promise<Array<{ name: string; path: string }>> {
  const examplesDir = path.resolve(__dirname, '../.docs/organized/code-examples');
  try {
    const files = await fs.readdir(examplesDir);
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => ({
        name: f.replace('.md', ''),
        path: f,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// Helper function to read a code example
async function readCodeExample(filename: string): Promise<string> {
  const examplesDir = path.resolve(__dirname, '../.docs/organized/code-examples');
  const filePath = path.join(examplesDir, filename);

  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    const examples = await listCodeExamples();
    const availableExamples = examples.map(ex => `- ${ex.name}`).join('\n');
    throw new Error(`Example "${filename}" not found.\n\nAvailable examples:\n${availableExamples}`);
  }
}

// Get initial examples for the description
const initialExamples = await listCodeExamples();
const examplesListing =
  initialExamples.length > 0
    ? '\n\nAvailable examples: ' + initialExamples.map(ex => ex.name).join(', ')
    : '\n\nNo examples available yet. Run the documentation preparation script first.';

server.addTool({
  name: 'mastraExamples',
  description:
    'Get code examples from the Mastra.ai examples directory. Without a specific example name, lists all available examples. With an example name, returns the full source code of that example.',
  parameters: z.object({
    example: z
      .string()
      .optional()
      .describe(
        'Name of the specific example to fetch. If not provided, lists all available examples.' + examplesListing,
      ),
  }),
  execute: async (args: { example?: string }) => {
    if (!args.example) {
      const examples = await listCodeExamples();
      return ['Available code examples:', '', ...examples.map(ex => `- ${ex.name}`).join('\n')].join('\n');
    }

    const filename = args.example.endsWith('.md') ? args.example : `${args.example}.md`;
    const content = await readCodeExample(filename);
    return content;
  },
});

// Helper function to encode package names for file paths
function encodePackageName(name: string): string {
  return encodeURIComponent(name);
}

// Helper function to decode package names from file paths
function decodePackageName(name: string): string {
  return decodeURIComponent(name);
}

// Helper function to list package changelogs
async function listPackageChangelogs(): Promise<Array<{ name: string; path: string }>> {
  const changelogsDir = path.resolve(__dirname, '../.docs/organized/changelogs');
  try {
    const files = await fs.readdir(changelogsDir);
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => ({
        name: decodePackageName(f.replace('.md', '')),
        path: f,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// Helper function to read a package changelog
async function readPackageChangelog(filename: string): Promise<string> {
  const changelogsDir = path.resolve(__dirname, '../.docs/organized/changelogs');
  const encodedName = encodePackageName(filename.replace('.md', '')); // Remove .md if present
  const filePath = path.join(changelogsDir, `${encodedName}.md`);

  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    const packages = await listPackageChangelogs();
    const availablePackages = packages.map(pkg => `- ${pkg.name}`).join('\n');
    throw new Error(
      `Changelog for "${filename.replace('.md', '')}" not found.\n\nAvailable packages:\n${availablePackages}`,
    );
  }
}

// Get initial packages for the description
const initialPackages = await listPackageChangelogs();
const packagesListing =
  initialPackages.length > 0
    ? '\n\nAvailable packages: ' + initialPackages.map(pkg => pkg.name).join(', ')
    : '\n\nNo package changelogs available yet. Run the documentation preparation script first.';

server.addTool({
  name: 'mastraChanges',
  description:
    'Get changelog information for Mastra.ai packages. Without a specific package name, lists all available packages. With a package name, returns the full changelog for that package.' +
    packagesListing,
  parameters: z.object({
    package: z
      .string()
      .optional()
      .describe('Name of the specific package to fetch changelog for. If not provided, lists all available packages.'),
  }),
  execute: async (args: { package?: string }) => {
    if (!args.package) {
      const packages = await listPackageChangelogs();
      return ['Available package changelogs:', '', ...packages.map(pkg => `- ${pkg.name}`).join('\n')].join('\n');
    }

    const content = await readPackageChangelog(args.package);
    return content;
  },
});

export { server };
