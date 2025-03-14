import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blogTool } from '../blog';
import fs from 'fs';
import path from 'path';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('blogTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('execute', () => {
    it('should list all blog posts when /blog is requested', async () => {
      const mockHtml = `
        <html>
          <body>
            <a href="/blog/post1">Post 1 January 1, 2024</a>
            <a href="/blog/post2">Post 2 January 2, 2024</a>
          </body>
        </html>
      `;
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockHtml),
      });

      const result = await blogTool.execute({ url: '/blog' });
      expect(result).toContain('Post 1');
      expect(result).toContain('Post 2');
      expect(result).toContain('January 1, 2024');
      expect(result).toContain('January 2, 2024');
    });

    it('should handle posts without dates in the listing', async () => {
      const mockHtml = `
        <html>
          <body>
            <a href="/blog/post1">Post 1 January 1, 2024</a>
            <a href="/blog/post2">Just a post without date</a>
          </body>
        </html>
      `;
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockHtml),
      });

      const result = await blogTool.execute({ url: '/blog' });
      expect(result).toContain('Post 1');
      expect(result).not.toContain('Just a post without date');
    });

    it('should handle different date formats in post titles', async () => {
      const mockHtml = `
        <html>
          <body>
            <a href="/blog/post1">Post 1 Jan 1, 2024</a>
            <a href="/blog/post2">Post 2 1/1/2024</a>
            <a href="/blog/post3">Post 3 2024-01-01</a>
          </body>
        </html>
      `;
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockHtml),
      });

      const result = await blogTool.execute({ url: '/blog' });
      expect(result).toContain('Post 1');
      expect(result).toContain('Post 2');
      expect(result).toContain('Post 3');
    });

    it('should handle relative and absolute URLs in blog listing', async () => {
      const mockHtml = `
        <html>
          <body>
            <a href="/blog/post1">Post 1 January 1, 2024</a>
            <a href="https://mastra.ai/blog/post2">Post 2 January 2, 2024</a>
          </body>
        </html>
      `;
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockHtml),
      });

      const result = await blogTool.execute({ url: '/blog' });
      expect(result).toContain('Post 1');
      expect(result).toContain('Post 2');
    });

    it('should return specific blog post content when URL is provided', async () => {
      const mockHtml = `
        <html>
          <body>
            <main>
              <h1>Test Post</h1>
              <p>Content here</p>
            </main>
          </body>
        </html>
      `;
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockHtml),
      });

      const result = await blogTool.execute({ url: 'https://mastra.ai/blog/test' });
      expect(result).toContain('# Test Post');
      expect(result).toContain('Content here');
    });

    it('should handle blog posts without main tag', async () => {
      const mockHtml = `
        <html>
          <body>
            <h1>Test Post</h1>
            <p>Content here</p>
          </body>
        </html>
      `;
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockHtml),
      });

      const result = await blogTool.execute({ url: 'https://mastra.ai/blog/test' });
      expect(result).toContain('# Test Post');
      expect(result).toContain('Content here');
    });

    it('should handle blog posts with complex HTML structure', async () => {
      const mockHtml = `
        <html>
          <body>
            <main>
              <h1>Test Post</h1>
              <p>Content here</p>
              <h2>Subtitle</h2>
              <ul>
                <li>Item 1</li>
                <li>Item 2</li>
              </ul>
              <pre><code>const x = 1;</code></pre>
              <blockquote>Quote here</blockquote>
              <img src="test.jpg" alt="Test image">
            </main>
          </body>
        </html>
      `;
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockHtml),
      });

      const result = await blogTool.execute({ url: 'https://mastra.ai/blog/test' });
      expect(result).toContain('# Test Post');
      expect(result).toContain('## Subtitle');
      expect(result).toContain('-   Item 1');
      expect(result).toContain('-   Item 2');
      expect(result).toContain('```\nconst x = 1;\n```');
      expect(result).toContain('> Quote here');
      expect(result).toContain('![Test image](test.jpg)');
    });

    it('should handle special characters in content', async () => {
      const mockHtml = `
        <html>
          <body>
            <main>
              <h1>Test Post with &quot;quotes&quot; and &amp; symbols</h1>
              <p>Content with <code>code</code> and <a href="https://example.com">links</a></p>
            </main>
          </body>
        </html>
      `;
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockHtml),
      });

      const result = await blogTool.execute({ url: 'https://mastra.ai/blog/test' });
      expect(result).toContain('# Test Post with "quotes" and & symbols');
      expect(result).toContain('Content with `code` and [links](https://example.com)');
    });

    it('should handle errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(blogTool.execute({ url: 'https://mastra.ai/blog/test' })).rejects.toThrow(
        'Failed to fetch blog content: Failed to fetch blog post: Network error',
      );
    });

    it('should handle invalid URLs', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Invalid URL'));

      await expect(blogTool.execute({ url: 'not-a-url' })).rejects.toThrow(
        'Failed to fetch blog content: Failed to fetch blog post: Invalid URL',
      );
    });

    it('should remove Next.js initialization code from blog post content', async () => {
      const mockHtml = fs.readFileSync(
        path.join(__dirname, '../__fixtures__/blog-post-raw.txt'),
        'utf-8'
      );
      
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockHtml),
      });

      const result = await blogTool.execute({ url: 'https://mastra.ai/blog/principles-of-ai-engineering' });
      
      // Verify content is preserved
      expect(result).toContain('## [](#principles-of-building-ai-agents)Principles of Building AI agents');
      expect(result).toContain('Today is YC demo day');
      
      // Verify Next.js initialization code is removed
      expect(result).not.toContain('self.__next_f=self.__next_f||[]).push([0]');
      expect(result).not.toContain('1:HL[');
      expect(result).not.toMatch(/\[\d+,"[\w\\\/\.-]+"\]/);
      expect(result).not.toContain('static/chunks');
      expect(result).not.toContain('__next');
    });
  });
});

