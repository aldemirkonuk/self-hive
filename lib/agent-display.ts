import { AGENTS } from './agents';
import { HIER_NODES } from './hierarchy';
import { LIBRARY } from './library/specialists';
import { FOUNDATIONAL_ROSTER } from './roster';

const FALLBACK_PALETTE = ['#22c55e', '#06b6d4', '#8b5cf6', '#ef4444', '#3b82f6', '#f59e0b'];

function normKey(s: string) {
  return s.toLowerCase().trim().replace(/\s+/g, '_');
}

function matchHierNode(identifier: string) {
  const key = normKey(identifier);
  const lower = identifier.toLowerCase().trim();
  return HIER_NODES.find(
    (n) =>
      n.key === key ||
      n.scoreTitle?.toLowerCase() === lower ||
      n.name.toLowerCase() === lower
  );
}

/** Resolve brand color for a roster id, library id, agent title, or pipeline role. */
export function resolveAgentColor(identifier: string): string {
  const node = matchHierNode(identifier);
  if (node) {
    if (node.color.startsWith('var(')) return '#f59e0b';
    return node.color;
  }

  const key = normKey(identifier);
  if (AGENTS[key]) return AGENTS[key].color;

  const roster = FOUNDATIONAL_ROSTER.find(
    (a) => a.id === key || a.title.toLowerCase() === identifier.toLowerCase().trim()
  );
  if (roster) return roster.color;

  const lib =
    LIBRARY[key] ??
    Object.values(LIBRARY).find((s) => s.title.toLowerCase() === identifier.toLowerCase().trim());
  if (lib) return lib.color;

  let h = 0;
  for (let i = 0; i < identifier.length; i++) h = (h * 31 + identifier.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

/** Short label for compact badges — matches /hive node initials (e.g. RSK, COS). */
export function agentBadgeIni(identifier: string): string {
  const node = matchHierNode(identifier);
  if (node) return node.ini;

  const key = normKey(identifier);
  if (AGENTS[key]) {
    return AGENTS[key].title
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 3)
      .toUpperCase();
  }

  const lib =
    LIBRARY[key] ??
    Object.values(LIBRARY).find((s) => s.title.toLowerCase() === identifier.toLowerCase().trim());
  if (lib) {
    const hier = matchHierNode(lib.id);
    if (hier) return hier.ini;
    return lib.title
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 3)
      .toUpperCase();
  }

  const words = identifier.replace(/_/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words
      .map((w) => w[0])
      .join('')
      .slice(0, 3)
      .toUpperCase();
  }
  return identifier.slice(0, 3).toUpperCase();
}
