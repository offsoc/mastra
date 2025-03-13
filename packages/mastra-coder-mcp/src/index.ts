import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.error('Starting Mastra Documentation Server...');
console.error('Docs base dir:', path.join(__dirname, '../.docs/raw/'));

const server = new FastMCP({
  name: 'Mastra Documentation Server',
  version: '1.0.0',
});

const docsBaseDir = path.join(__dirname, '../.docs/raw/');

// Helper function to fetch and parse blog posts
async function fetchBlogPosts(): Promise<Array<{ title: string; date: string; url: string }>> {
  console.error('Fetching blog posts...');
  try {
    const response = await fetch('https://mastra.ai/blog');
    const html = await response.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Find all blog post links
    const posts: Array<{ title: string; date: string; url: string }> = [];
    const links = document.querySelectorAll('a');

    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;

      // Look for blog post links that have a date
      const dateText = link.textContent?.match(/\w+ \d+, \d{4}/);
      if (dateText) {
        const title = link.textContent?.replace(dateText[0], '').trim() || '';
        posts.push({
          title,
          date: dateText[0],
          url: href.startsWith('http') ? href : `https://mastra.ai${href}`,
        });
      }
    }

    console.error(`Found ${posts.length} blog posts`);
    return posts;
  } catch (error) {
    console.error('Error fetching blog posts:', error);
    throw new Error('Failed to fetch blog posts');
  }
}

// Helper function to fetch and convert a blog post to markdown
async function fetchBlogPost(url: string): Promise<string> {
  console.error('Fetching blog post:', url);
  try {
    const response = await fetch(url);
    const html = await response.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Find the main content area
    const mainContent = document.querySelector('main') || document.body;

    // Convert HTML to markdown-like format
    let markdown = '';

    // Helper function to process text nodes
    function processTextNode(node: Node): string {
      return node.textContent?.trim() || '';
    }

    // Helper function to process element nodes
    function processElementNode(node: Element): string {
      const tagName = node.tagName.toLowerCase();
      const children = Array.from(node.childNodes)
        .map(child => {
          if (child.nodeType === 3) return processTextNode(child);
          if (child.nodeType === 1) return processElementNode(child as Element);
          return '';
        })
        .filter(Boolean)
        .join(' ');

      switch (tagName) {
        case 'h1':
          return `\n# ${children}\n\n`;
        case 'h2':
          return `\n## ${children}\n\n`;
        case 'h3':
          return `\n### ${children}\n\n`;
        case 'p':
          return `${children}\n\n`;
        case 'a':
          const href = node.getAttribute('href');
          return href ? `[${children}](${href})` : children;
        case 'code':
          return `\`${children}\``;
        case 'pre':
          return `\`\`\`\n${children}\n\`\`\`\n\n`;
        case 'ul':
          return (
            Array.from(node.children)
              .map(li => `- ${processElementNode(li)}`)
              .join('\n') + '\n\n'
          );
        case 'ol':
          return (
            Array.from(node.children)
              .map((li, i) => `${i + 1}. ${processElementNode(li)}`)
              .join('\n') + '\n\n'
          );
        case 'li':
          return children;
        case 'blockquote':
          return `> ${children}\n\n`;
        case 'img':
          const src = node.getAttribute('src');
          const alt = node.getAttribute('alt') || '';
          return src ? `![${alt}](${src})\n\n` : '';
        default:
          return children;
      }
    }

    // Process all nodes in the main content
    markdown = Array.from(mainContent.childNodes)
      .map(node => {
        if (node.nodeType === 3) return processTextNode(node);
        if (node.nodeType === 1) return processElementNode(node as Element);
        return '';
      })
      .filter(Boolean)
      .join('')
      .replace(/\n{3,}/g, '\n\n') // Remove excessive newlines
      .trim();

    console.error('Successfully converted blog post to markdown');
    return markdown;
  } catch (error) {
    console.error('Error fetching blog post:', error);
    throw new Error(`Failed to fetch blog post: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

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

server.addTool({
  name: 'mastraBlog',
  description:
    'Get Mastra.ai blog content. Without a URL, returns a list of all blog posts. With a URL, returns the specific blog post content in markdown format. The blog contains changelog posts as well as announcements and posts about Mastra features and AI news',
  parameters: z.object({
    url: z
      .string()
      .describe(
        'URL of a specific blog post to fetch. If the string /blog is passed as the url it returns a list of all blog posts.',
      ),
  }),
  execute: async args => {
    console.error('mastraBlog tool called with args:', args);
    try {
      if (args.url !== `/blog`) {
        console.error('Fetching specific blog post:', args.url);
        const content = await fetchBlogPost(args.url);
        console.error('Successfully fetched blog post');
        return content;
      } else {
        console.error('Fetching blog post list');
        const posts = await fetchBlogPosts();
        const output = [
          'Mastra.ai Blog Posts:',
          '',
          ...posts.map(post => `- ${post.title} (${post.date})\n  ${post.url}`),
        ].join('\n');
        console.error('Successfully fetched blog posts');
        return output;
      }
    } catch (error) {
      console.error('Error in mastraBlog tool:', error);
      if (error instanceof Error) {
        throw new Error(`Failed to fetch blog content: ${error.message}`);
      }
      throw error;
    }
  },
});

console.error('Starting server...');
void server.start({
  transportType: 'stdio',
});
