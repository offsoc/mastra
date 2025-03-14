import TurndownService from 'turndown';
import { z } from 'zod';

// Helper function to fetch blog posts as markdown
async function fetchBlogPosts(): Promise<string> {
  try {
    const response = await fetch('https://mastra.ai/blog');
    const html = await response.text();
    
    // Configure turndown
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      emDelimiter: '_',
      bulletListMarker: '-',
      linkStyle: 'inlined',
    });

    // Convert HTML to markdown and return
    const markdown = turndownService.turndown(html);
    return `Mastra.ai Blog Posts:\n\n${markdown}`;
  } catch (error) {
    throw new Error('Failed to fetch blog posts');
  }
}

// Helper function to fetch and convert a blog post to markdown
async function fetchBlogPost(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    const html = await response.text();

    // Configure turndown
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      emDelimiter: '_',
      bulletListMarker: '-',
    });

    // Convert HTML to markdown
    let markdown = turndownService.turndown(html);

    // Clean up Next.js initialization code and other artifacts
    markdown = markdown
      .replace(/\(self\.__next_f=self\.__next_f\|\|\[\]\)\.push\(\[[^\]]*\]\);?/g, '') // Remove Next.js initialization
      .replace(/\[\d+,"[\w\\\/\.-]+"\]/g, '') // Remove chunk references
      .replace(/static\/chunks\/[^"\s]+/g, '') // Remove chunk paths
      .replace(/__next[^"\s]+/g, '') // Remove Next.js related paths
      .replace(/\n{3,}/g, '\n\n') // Remove excessive newlines
      .trim();

    return markdown;
  } catch (error) {
    throw new Error(`Failed to fetch blog post: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export const blogTool = {
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
  execute: async (args: { url: string }) => {
    try {
      if (args.url !== `/blog`) {
        return await fetchBlogPost(args.url);
      } else {
        return await fetchBlogPosts();
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to fetch blog content: ${error.message}`);
      }
      throw error;
    }
  },
};
