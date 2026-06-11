import { getServerSupabase, isSupabaseConfigured } from './supabase-server';

export interface RunSummary {
  id: string;
  problem: string;
  runCount: number;
  status: string;
  createdAt: string;
  kind: string; // 'fixed' | 'dynamic'
  answer: string | null;
  classification: string | null;
  agentRoles: string[]; // which agents participated this run
  scores: Record<string, number> | null; // role/title → overall score
  hasTrainerReport: boolean; // whether a trainer report exists for this run
}

export interface TrainerHistoryEntry {
  runCount: number;
  createdAt: string;
  scores: Record<string, number>; // role → overall
}

/**
 * Fetch the last N runs for a user, with the agents that participated and their
 * scores. Feeds the History page.
 */
export async function getRecentRuns(userId: string, limit = 20): Promise<RunSummary[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await getServerSupabase();

  const { data: runs, error } = await sb
    .from('runs')
    .select('id, problem, run_count, status, created_at, kind, answer, classification')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !runs) return [];

  // Pull participating agents per run
  const runIds = runs.map((r) => r.id);
  const { data: arts } = await sb
    .from('artifacts')
    .select('run_id, role')
    .in('run_id', runIds);

  const { data: reports } = await sb
    .from('trainer_reports')
    .select('run_id, scores')
    .in('run_id', runIds);

  const rolesByRun = new Map<string, string[]>();
  (arts ?? []).forEach((a) => {
    const list = rolesByRun.get(a.run_id) ?? [];
    if (!list.includes(a.role)) list.push(a.role);
    rolesByRun.set(a.run_id, list);
  });

  // Dynamic (company) runs have no `artifacts` rows — their roster lives in the
  // run_events stream. Derive the participating agents from agent_start events
  // (payload.agentTitle, the same string the Trainer keys its scores by) so the
  // History row always shows agent widgets — even when the Trainer emitted an
  // empty scores object, which previously hid every badge for that run.
  const dynamicRunIds = runs.filter((r) => (r.kind ?? 'fixed') === 'dynamic').map((r) => r.id);
  const dynRolesByRun = new Map<string, string[]>();
  if (dynamicRunIds.length > 0) {
    const { data: starts } = await sb
      .from('run_events')
      .select('run_id, payload')
      .eq('type', 'agent_start')
      .in('run_id', dynamicRunIds)
      .order('id', { ascending: true });
    (starts ?? []).forEach((e) => {
      const title = (e.payload as { agentTitle?: string } | null)?.agentTitle;
      if (!title) return;
      const list = dynRolesByRun.get(e.run_id) ?? [];
      if (!list.includes(title)) list.push(title);
      dynRolesByRun.set(e.run_id, list);
    });
  }

  const scoresByRun = new Map<string, Record<string, number>>();
  (reports ?? []).forEach((r) => {
    const s = r.scores as Record<string, { overall?: number }> | null;
    if (s) {
      const flat: Record<string, number> = {};
      for (const [role, val] of Object.entries(s)) {
        if (val && typeof val.overall === 'number') flat[role] = val.overall;
      }
      scoresByRun.set(r.run_id, flat);
    }
  });

  // Note: we already fetched `reports` above (run_id + scores) — a row in that
  // list IS proof a trainer_report exists. No extra query needed.
  const reportRunIds = new Set((reports ?? []).map((r) => r.run_id));

  return runs.map((r) => {
    const scores = scoresByRun.get(r.id) ?? null;
    // Dynamic runs: when the Trainer produced per-agent scores, key off those
    // titles so each badge keeps its score overlay (the Trainer occasionally
    // shortens a title, so its keys are the source of truth for scored runs).
    // Otherwise fall back to the run_events roster so badges still appear when
    // scores are empty/missing. Fixed runs use the artifact roles.
    const hasScores = !!scores && Object.keys(scores).length > 0;
    const fixedRoles = rolesByRun.get(r.id) ?? [];
    const agentRoles =
      r.kind === 'dynamic'
        ? (hasScores ? Object.keys(scores!) : (dynRolesByRun.get(r.id) ?? []))
        : fixedRoles;
    return {
      id: r.id,
      problem: r.problem,
      runCount: r.run_count,
      status: r.status,
      createdAt: r.created_at,
      kind: r.kind ?? 'fixed',
      answer: r.answer ?? null,
      classification: r.classification ?? null,
      agentRoles,
      scores,
      hasTrainerReport: reportRunIds.has(r.id),
    };
  });
}

/**
 * Fetch one trainer report for a single run. RLS on `trainer_reports` is
 * enforced via the same session-scoped client used elsewhere — a user can
 * only ever read reports for their own runs.
 */
export interface TrainerReportRow {
  rawText: string;
  scores: Record<string, { overall?: number } & Record<string, number>> | null;
  patterns: Record<string, unknown> | null;
  oneThingCompany: string;
}
export async function getTrainerReport(runId: string): Promise<TrainerReportRow | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = await getServerSupabase();
  const { data } = await sb
    .from('trainer_reports')
    .select('raw_text, scores, patterns, one_thing_company')
    .eq('run_id', runId)
    .maybeSingle();
  if (!data) return null;
  return {
    rawText: data.raw_text ?? '',
    scores: (data.scores as TrainerReportRow['scores']) ?? null,
    patterns: (data.patterns as TrainerReportRow['patterns']) ?? null,
    oneThingCompany: data.one_thing_company ?? '',
  };
}

/**
 * Compact score history the TRAINER reads to detect trends. Last N completed
 * runs, oldest→newest, with each agent's overall score.
 */
export async function getTrainerHistory(userId: string, limit = 5): Promise<TrainerHistoryEntry[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await getServerSupabase();

  const { data: runs } = await sb
    .from('runs')
    .select('id, run_count, created_at')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!runs || runs.length === 0) return [];

  const runIds = runs.map((r) => r.id);
  const { data: reports } = await sb
    .from('trainer_reports')
    .select('run_id, scores')
    .in('run_id', runIds);

  const scoresByRun = new Map<string, Record<string, number>>();
  (reports ?? []).forEach((r) => {
    const s = r.scores as Record<string, { overall?: number }> | null;
    if (s) {
      const flat: Record<string, number> = {};
      for (const [role, val] of Object.entries(s)) {
        if (val && typeof val.overall === 'number') flat[role] = val.overall;
      }
      scoresByRun.set(r.run_id, flat);
    }
  });

  return runs
    .map((r) => ({
      runCount: r.run_count,
      createdAt: r.created_at,
      scores: scoresByRun.get(r.id) ?? {},
    }))
    .filter((e) => Object.keys(e.scores).length > 0)
    .reverse(); // oldest → newest for trend reading
}

/**
 * Format trainer history into a compact text block for injection into the
 * TRAINER's prompt. Returns '' if no history (TRAINER will say INSUFFICIENT_DATA).
 */
export function formatHistoryForTrainer(history: TrainerHistoryEntry[]): string {
  if (history.length === 0) return '';
  const lines = history.map((e) => {
    const parts = Object.entries(e.scores)
      .map(([role, score]) => `${role.toUpperCase()} ${score.toFixed(1)}`)
      .join(', ');
    return `Run #${e.runCount}: ${parts}`;
  });
  return `\n\nPRIOR RUN HISTORY (oldest → newest) — use this to compute real Health Trajectory and detect patterns across runs:\n${lines.join('\n')}\n`;
}
