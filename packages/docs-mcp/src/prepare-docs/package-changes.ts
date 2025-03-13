import fs from 'node:fs/promises';
import path from 'node:path';

const PACKAGES_SOURCE = '../../packages';
const CHANGELOGS_DEST = './.docs/organized/changelogs';
const MAX_LINES = 300;

/**
 * Truncates content to a maximum number of lines and adds a message about hidden lines
 */
function truncateContent(content: string, maxLines: number): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  
  const visibleLines = lines.slice(0, maxLines);
  const hiddenCount = lines.length - maxLines;
  return visibleLines.join('\n') + `\n\n... ${hiddenCount} more lines hidden. See full changelog in package directory.`;
}

/**
 * Scans package directories and creates organized changelog files
 */
export async function preparePackageChanges() {
  const packagesDir = path.resolve(process.cwd(), PACKAGES_SOURCE);
  const outputDir = path.resolve(process.cwd(), CHANGELOGS_DEST);

  // Clean up existing output directory
  try {
    await fs.rm(outputDir, { recursive: true, force: true });
  } catch {
    // Ignore errors if directory doesn't exist
  }

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Get all package directories
  const entries = await fs.readdir(packagesDir, { withFileTypes: true });
  const packageDirs = entries
    .filter(entry => entry.isDirectory())
    .filter(entry => entry.name !== 'docs-mcp' && entry.name !== '_config');

  for (const dir of packageDirs) {
    const packagePath = path.join(packagesDir, dir.name);
    
    // Try to read package.json first
    let packageName: string;
    try {
      const packageJsonPath = path.join(packagePath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
      packageName = packageJson.name;
      if (!packageName) {
        console.log(`Skipping ${dir.name}: No package name found in package.json`);
        continue;
      }
    } catch {
      console.log(`Skipping ${dir.name}: No valid package.json found`);
      continue;
    }

    // Try to read CHANGELOG.md
    try {
      const changelogPath = path.join(packagePath, 'CHANGELOG.md');
      let changelog: string;
      try {
        changelog = await fs.readFile(changelogPath, 'utf-8');
        changelog = truncateContent(changelog, MAX_LINES);
      } catch {
        changelog = 'No changelog available.';
      }

      // Write to output file using URL-encoded package name
      const outputFile = path.join(outputDir, `${encodeURIComponent(packageName)}.md`);
      await fs.writeFile(outputFile, changelog, 'utf-8');
      console.log(`Generated changelog for ${packageName}`);
    } catch (error) {
      console.error(`Error processing changelog for ${packageName}:`, error);
    }
  }
} 