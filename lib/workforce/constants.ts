// The self-staffing gate. These constants are the ENTIRE promotion/retirement
// policy — tune them here, nowhere else. The founder's directive: fully
// autonomous, but only hard geniuses become permanent, and they must prove
// themselves more than once.

export const WORKFORCE = {
  // ── PROMOTION (candidate → permanent staff) ──
  // "prove themselves more than once": at least this many scored appearances.
  PROMOTE_MIN_APPEARANCES: 3,
  // "hard genius": rolling average trainer `overall` (0-10) must clear this.
  // Most agents land 6-8, so 8.5 is genuinely top-tier.
  PROMOTE_MIN_ROLLING: 8.5,
  // "not erratic": a single disastrous appearance disqualifies. The worst score
  // the cluster ever earned must still be at or above this floor.
  PROMOTE_MIN_FLOOR: 7.5,

  // ── RETIREMENT (promoted → retired) ──
  // Symmetric loop: a permanent agent that drifts below this rolling score gets
  // auto-retired (custom_agents.active = false). Keeps the standing org lean.
  RETIRE_ROLLING_BELOW: 7.5,
  // Don't judge retirement on thin data — require this many appearances first.
  RETIRE_MIN_APPEARANCES: 3,
} as const;

// Cheap reasoning model for the Registrar (identity resolution) and the Spawner's
// canonical-prompt synthesis. Identity + synthesis are bounded tasks — Haiku is
// the right cost tier. Matches the ids used in lib/library/cfo.ts.
export const WORKFORCE_MODEL = 'claude-haiku-4-5';

// Stable purple for promoted specialists, distinct from founder agents.
export const PROMOTED_COLOR = '#a855f7';
