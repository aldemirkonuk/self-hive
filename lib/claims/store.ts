// Slice 2 — persistence + read-back for the generalized outcome loop.
//
// A claim is the non-markets sibling of a prediction: a falsifiable assertion the
// founder later grades true/false. Resolved claims feed the SAME Calibration
// Ledger as markets predictions — getOverallCalibration unions both, so the moat
// (calibrated rows) spans every domain, not just markets. Coverage tracks the
// Businessman's metric: what fraction of claims carry an exogenous label yet.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabase, isSupabaseConfigured } from '../db/supabase-server';
import { computeCalibration, type CalibrationReport, type ResolvedPrediction } from '../markets/calibration';
import { getResolvedPredictionRows } from '../markets/portfolio';
import type { RawClaim } from './extract';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any, any, any>;

const DAY_MS = 86_400_000;

/** Persist freshly-extracted claims as open rows awaiting a founder verdict. */
export async function recordClaims(
  userId: string,
  runId: string,
  domain: string,
  claims: RawClaim[],
  sbOverride?: SB,
): Promise<number> {
  if (!isSupabaseConfigured() || claims.length === 0) return 0;
  const sb = sbOverride ?? (await getServerSupabase());

  const rows = claims.map((c) => ({
    user_id: userId,
    run_id: runId,
    domain: domain || 'general',
    claim: c.claim,
    confidence: c.confidence,
    horizon_days: c.horizonDays,
    check_at: new Date(Date.now() + c.horizonDays * DAY_MS).toISOString(),
    status: 'open',
  }));

  const { error } = await sb.from('claims').insert(rows);
  return error ? 0 : rows.length;
}

export interface OpenClaim {
  id: string;
  domain: string;
  claim: string;
  confidence: number;
  createdAt: string;
  checkAt: string | null;
  /** True once the suggested review date has passed (it's ripe to grade). */
  due: boolean;
}

/** Open claims awaiting a verdict, oldest-checkable first. */
export async function getOpenClaims(userId: string, sbOverride?: SB): Promise<OpenClaim[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = sbOverride ?? (await getServerSupabase());

  const { data } = await sb
    .from('claims')
    .select('id, domain, claim, confidence, created_at, check_at')
    .eq('user_id', userId)
    .eq('status', 'open')
    .order('check_at', { ascending: true });

  const now = Date.now();
  return (data ?? []).map((r) => ({
    id: String(r.id),
    domain: String(r.domain ?? 'general'),
    claim: String(r.claim ?? ''),
    confidence: Number(r.confidence ?? 0.6),
    createdAt: String(r.created_at),
    checkAt: r.check_at ? String(r.check_at) : null,
    due: r.check_at ? new Date(r.check_at).getTime() <= now : false,
  }));
}

/**
 * The founder's verdict — the exogenous label. Guarded by user_id so one founder
 * can't grade another's claims (RLS also enforces this, this is defence in depth).
 */
export async function resolveClaim(
  userId: string,
  claimId: string,
  correct: boolean,
  note?: string,
  sbOverride?: SB,
): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const sb = sbOverride ?? (await getServerSupabase());

  const { error } = await sb
    .from('claims')
    .update({
      status: 'resolved',
      resolved_correct: correct,
      resolution_note: note?.slice(0, 1000) ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', claimId)
    .eq('user_id', userId);

  return !error;
}

/** Founder-resolved claims as calibration rows (confidence ↔ verdict). */
export async function getResolvedClaimRows(userId: string, sbOverride?: SB): Promise<ResolvedPrediction[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = sbOverride ?? (await getServerSupabase());

  const { data } = await sb
    .from('claims')
    .select('confidence, resolved_correct')
    .eq('user_id', userId)
    .eq('status', 'resolved')
    .not('resolved_correct', 'is', null);

  return (data ?? [])
    .filter((r) => r.confidence != null && r.resolved_correct != null)
    .map((r) => ({
      confidence: Number(r.confidence),
      correct: Boolean(r.resolved_correct),
      outcomePct: 0, // claims carry no return; only a binary verdict
    }));
}

export interface ClaimCoverage {
  total: number;
  open: number;
  resolved: number;
  /** Fraction of (non-dismissed) claims that now carry an exogenous label. */
  resolvedFraction: number;
}

/** The Businessman's metric: how much of the claim corpus is exogenously graded. */
export async function getClaimCoverage(userId: string, sbOverride?: SB): Promise<ClaimCoverage> {
  const empty: ClaimCoverage = { total: 0, open: 0, resolved: 0, resolvedFraction: 0 };
  if (!isSupabaseConfigured()) return empty;
  const sb = sbOverride ?? (await getServerSupabase());

  const { data } = await sb.from('claims').select('status').eq('user_id', userId);
  const rows = data ?? [];
  const open = rows.filter((r) => r.status === 'open').length;
  const resolved = rows.filter((r) => r.status === 'resolved').length;
  const graded = open + resolved; // exclude dismissed from the denominator
  return {
    total: rows.length,
    open,
    resolved,
    resolvedFraction: graded > 0 ? resolved / graded : 0,
  };
}

export interface OverallCalibration {
  report: CalibrationReport;
  marketsN: number;
  claimsN: number;
}

/**
 * Calibration across EVERY domain: markets predictions (auto-resolved against
 * price) + founder-resolved claims (graded against reality). This is the moat as
 * one number, spanning the whole company — not just the markets desk.
 */
export async function getOverallCalibration(userId: string, sbOverride?: SB): Promise<OverallCalibration> {
  const [markets, claims] = await Promise.all([
    getResolvedPredictionRows(userId, sbOverride),
    getResolvedClaimRows(userId, sbOverride),
  ]);
  return {
    report: computeCalibration([...markets, ...claims]),
    marketsN: markets.length,
    claimsN: claims.length,
  };
}
