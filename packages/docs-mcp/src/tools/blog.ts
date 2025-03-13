import { JSDOM } from 'jsdom';
import { z } from 'zod';

interface BlogPost {
  title: string;
  date: string;
  url: string;
}

// Helper function to fetch and parse blog posts
async function fetchBlogPosts(): Promise<BlogPost[]> {
  try {
    const response = await fetch('https://mastra.ai/blog');
    const html = await response.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Find all blog post links
    const posts: BlogPost[] = [];
    const links = document.querySelectorAll('a');

    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;

      // Look for blog post links that have a date
      const dateText = link.textContent?.match(/(?:\w+ \d+, \d{4}|[A-Za-z]+ \d+,? \d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
      if (dateText) {
        const title = link.textContent?.replace(dateText[0], '').trim() || '';
        posts.push({
          title,
          date: dateText[0],
          url: href.startsWith('http') ? href : `https://mastra.ai${href}`,
        });
      }
    }

    return posts;
  } catch (error) {
    throw new Error('Failed to fetch blog posts');
  }
}

// Helper function to fetch and convert a blog post to markdown
async function fetchBlogPost(url: string): Promise<string> {
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
          // If parent is pre, don't wrap in backticks as it's already a code block
          if (node.parentElement?.tagName.toLowerCase() === 'pre') {
            return children;
          }
          return `\`${children}\``;
        case 'pre':
          // If contains a code element, use its content directly
          const codeElement = node.querySelector('code');
          const content = codeElement ? codeElement.textContent || children : children;
          return `\`\`\`\n${content}\n\`\`\`\n\n`;
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

    return markdown;
  } catch (error) {
    throw new Error(`Failed to fetch blog post: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export const blogTool = {
  name: 'mastraBlog',
  description: 'Get Mastra.ai blog content. Without a URL, returns a list of all blog posts. With a URL, returns the specific blog post content in markdown format. The blog contains changelog posts as well as announcements and posts about Mastra features and AI news',
  parameters: z.object({
    url: z
      .string()
      .describe(
        'URL of a specific blog post to fetch. If the string /blog is passed as the url it returns a list of all blog posts.',
      ),
  }),
  execute: async (args: { url: string }) => {
    try {
      if (args.url !== `/blog`) {
        const content = await fetchBlogPost(args.url);
        return content;
      } else {
        const posts = await fetchBlogPosts();
        const output = [
          'Mastra.ai Blog Posts:',
          '',
          ...posts.map(post => `- ${post.title} (${post.date})\n  ${post.url}`),
        ].join('\n');
        return output;
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to fetch blog content: ${error.message}`);
      }
      throw error;
    }
  },
}; 