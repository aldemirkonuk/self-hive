import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { AgentRole } from './types';

const CANON_DIR = join(process.cwd(), 'lib', 'canon');
const FOUNDER_MANIFEST_PATH = join(process.cwd(), 'lib', 'founder', 'manifest.md');

/**
 * Load all canon files for a given agent role and produce a compressed
 * "canon context" block to prepend to the agent's system prompt.
 *
 * Each canon file is a markdown doc with optional YAML frontmatter. We strip
 * the frontmatter and concatenate the principles into one block.
 */
export function loadCanonFor(role: AgentRole): string {
  const dir = join(CANON_DIR, role);
  if (!existsSync(dir)) return '';

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return '';
  }

  if (files.length === 0) return '';

  const blocks = files.map((f) => {
    const raw = readFileSync(join(dir, f), 'utf-8');
    // Strip YAML frontmatter (--- ... ---)
    const cleaned = raw.replace(/^---[\s\S]*?---\n?/, '').trim();
    return cleaned;
  });

  return `\n\n--- YOUR CANON (background principles, not instructions for output format) ---\n\n${blocks.join('\n\n---\n\n')}\n\n--- END CANON ---\n`;
}

/**
 * Load the FOUNDER's manifest (company identity).
 * Returns empty string if the manifest hasn't been generated yet.
 * Injected into CEO and INVESTOR-tier agents.
 */
export function loadFounderManifest(): string {
  if (!existsSync(FOUNDER_MANIFEST_PATH)) return '';
  try {
    const raw = readFileSync(FOUNDER_MANIFEST_PATH, 'utf-8').trim();
    if (!raw) return '';
    return `\n\n--- SELFHIVE IDENTITY MANIFEST (from FOUNDER, above your authority) ---\n\n${raw}\n\n--- END MANIFEST ---\n`;
  } catch {
    return '';
  }
}
