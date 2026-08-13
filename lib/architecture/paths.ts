// THE EXECUTION-PATH CAPABILITY REGISTRY.
//
// SELFHIVE grew three ways to run a company, and they drifted. Path A (the fixed
// six-agent pipeline) was used once, in May, and never metered a token. Path B
// (the dynamic runner) is missing the distiller, the immunizer, the editor, the
// elastic workforce and the approval gate — and it is the AUTOMATIC FALLBACK
// when the durable workflow fails to start, so a bad afternoon silently demoted
// the company to a lesser version of itself with nothing said.
//
// Nothing detected that. Every capability was added by hand to whichever path
// the author happened to be editing, and the gap only surfaced when someone went
// looking. This file exists so that stops being true: the registry below is the
// definition of "the company", and the test beside it fails when a path cannot
// deliver it.
//
// KNOWN_GAPS is the honest part. It is a ledger of what is still missing, and it
// is allowed to SHRINK and never grow — a new gap has to be argued for in a diff,
// not discovered months later in a postmortem.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ExecutionPath {
  id: string;
  title: string;
  /** Files that, together, implement this path. Repo-relative. */
  files: string[];
  /** The canonical path is the one every other path is measured against. */
  canonical?: boolean;
}

export const PATHS: ExecutionPath[] = [
  {
    id: 'workflow',
    title: 'Durable workflow (autonomous cron, primary)',
    files: ['lib/jobs/step-impl.ts', 'app/workflows/selfhive-run.ts'],
    canonical: true,
  },
  {
    id: 'direct',
    title: 'Direct executor (/company, and the workflow fallback)',
    files: ['lib/jobs/runner.ts', 'lib/orchestrator-dynamic.ts'],
  },
];

export interface Capability {
  id: string;
  /** What the company loses when a path lacks this. */
  matters: string;
  /** Source markers; a path HAS the capability if any marker appears in any of its files. */
  markers: string[];
}

/**
 * What it means to be SELFHIVE. Ordered roughly by how visible the loss is.
 */
export const CAPABILITIES: Capability[] = [
  { id: 'cost_metering', matters: 'spend never reaches the ledger; the CFO and the digest both go blind', markers: ['callModel'] },
  { id: 'goal_ledger', matters: 'the company forgets what it is working toward and what it already settled', markers: ['loadGoalLedger'] },
  { id: 'calibration_feedback', matters: 'the hive stops being told its stated confidence does not predict outcomes', markers: ['loadCalibrationBlock'] },
  { id: 'recall', matters: 'no memory of similar past problems when composing', markers: ['recallBlock'] },
  { id: 'reputation', matters: 'agent standings stop steering composition', markers: ['reputationBlock'] },
  { id: 'markets_outcome_loop', matters: 'predictions are never recorded, so nothing is ever graded by reality', markers: ['extractPredictions'] },
  { id: 'position_guard', matters: 'contradictory and duplicate positions can be opened again', markers: ['recordAndAllocate'] },
  { id: 'claims_outcome_loop', matters: 'non-markets work produces no falsifiable claim for the founder to grade', markers: ['extractClaims'] },
  { id: 'workforce', matters: 'spawned specialists are never promoted or retired', markers: ['recordSpawnedWorkforce'] },
  { id: 'trainer', matters: 'no run is scored, so nothing downstream can learn', markers: ['parseDynamicTrainerScores', 'dynamicTrainerSystemPrompt'] },
  { id: 'distiller', matters: 'lessons are never distilled into learned overlays', markers: ['distill'] },
  { id: 'immunizer', matters: 'failure patterns are never turned into antibodies', markers: ['immuniz'] },
  { id: 'editor', matters: 'raw agent output is shipped unformatted', markers: ['editor'] },
  { id: 'approval_gate', matters: 'self-modification happens with no audit row in /approvals', markers: ['auditAutoApproved'] },
  { id: 'elastic', matters: 'no budget-governed squads or sub-teams', markers: ['isElastic'] },
];

/**
 * Capabilities a path is KNOWINGLY missing, with the reason. This list may only
 * shrink. Each entry is a standing admission that the company is not the same
 * company depending on which path runs it.
 */
export const KNOWN_GAPS: Record<string, Array<{ capability: string; why: string }>> = {
  // Opening balance, measured 2026-08-13. Every one of these is a way the
  // company is quietly worse when the durable workflow fails to start and the
  // direct executor picks up the run instead.
  direct: [
    { capability: 'distiller', why: 'the run is scored but its lessons never become learned overlays, so a fallback run teaches the company nothing' },
    { capability: 'immunizer', why: 'failure patterns from a fallback run never become antibodies, so the same failure stays repeatable' },
    { capability: 'editor', why: 'artifacts ship unformatted on this path; cosmetic next to the others but visible to the founder' },
    { capability: 'approval_gate', why: 'self-modification on this path lands with no change_requests row, so /approvals is not the complete history it claims to be' },
    { capability: 'elastic', why: 'no budget-governed squads or folded sub-teams; the fallback runs a flat team regardless of problem shape' },
  ],
};

const root = process.cwd();

export function sourceOf(path: ExecutionPath): string {
  return path.files
    .map((f) => {
      try {
        return readFileSync(join(root, f), 'utf-8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

export function hasCapability(source: string, cap: Capability): boolean {
  return cap.markers.some((m) => source.includes(m));
}

/** Capabilities the canonical path has that `path` does not. */
export function missingFrom(path: ExecutionPath): Capability[] {
  const canonical = PATHS.find((p) => p.canonical)!;
  const canonicalSrc = sourceOf(canonical);
  const src = sourceOf(path);
  return CAPABILITIES.filter((c) => hasCapability(canonicalSrc, c) && !hasCapability(src, c));
}
