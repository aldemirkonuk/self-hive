import { NextRequest } from 'next/server';
import { runTeam } from '@/lib/orchestrator';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';
import { createRunRecord, saveArtifact, markRunComplete, saveTrainerReport, recordEarnings } from '@/lib/db/runs';
import { getTrainerHistory, formatHistoryForTrainer } from '@/lib/db/history';
import { parseTrainerScores } from '@/lib/trainer/parse';
import { AgentRole, PersonaMode } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_PROBLEM_LEN = 2000;
const MIN_PROBLEM_LEN = 10;
const MAX_RUN_COUNT = 10_000;

// CR-01: per-IP rate limit. In-memory (module scope). Survives across requests
// on the same Fluid Compute instance, resets on cold start. For personal infra
// this is acceptable; upgrade to Upstash Redis when SELFHIVE goes public.
const RATE_LIMIT_PER_HOUR = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;
interface RateBucket { count: number; resetAt: number }
const rateBuckets = new Map<string, RateBucket>();

function checkRateLimit(ip: string): { ok: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  // Periodic cleanup to prevent unbounded Map growth
  if (rateBuckets.size > 1000) {
    for (const [k, b] of rateBuckets) if (b.resetAt < now) rateBuckets.delete(k);
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    const fresh = { count: 1, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, fresh);
    return { ok: true, remaining: RATE_LIMIT_PER_HOUR - 1, resetAt: fresh.resetAt };
  }
  if (bucket.count >= RATE_LIMIT_PER_HOUR) {
    return { ok: false, remaining: 0, resetAt: bucket.resetAt };
  }
  bucket.count++;
  return { ok: true, remaining: RATE_LIMIT_PER_HOUR - bucket.count, resetAt: bucket.resetAt };
}

// CR-04 placeholder: hardcoded global ceiling until CFO agent is built.
// CFO will replace this with per-run budget decisions (model tier, max_tokens,
// agent-skip logic). This is a safety net, NOT a real budget system.
const GLOBAL_DAILY_RUN_CAP = 50;
let dailyRunCount = 0;
let dailyWindowStart = Date.now();
function checkDailyCap(): { ok: boolean; remaining: number } {
  const now = Date.now();
  if (now - dailyWindowStart > 24 * 60 * 60 * 1000) {
    dailyRunCount = 0;
    dailyWindowStart = now;
  }
  if (dailyRunCount >= GLOBAL_DAILY_RUN_CAP) return { ok: false, remaining: 0 };
  dailyRunCount++;
  return { ok: true, remaining: GLOBAL_DAILY_RUN_CAP - dailyRunCount };
}

export async function POST(req: NextRequest) {
  // CR-01: per-IP rate limit before any work happens
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';
  const rate = checkRateLimit(ip);
  if (!rate.ok) {
    return new Response(
      JSON.stringify({
        error: `Rate limit exceeded. Try again at ${new Date(rate.resetAt).toISOString()}.`,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': String(RATE_LIMIT_PER_HOUR),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor(rate.resetAt / 1000)),
          'Retry-After': String(Math.ceil((rate.resetAt - Date.now()) / 1000)),
        },
      }
    );
  }

  // CR-04 placeholder: global daily safety cap
  const daily = checkDailyCap();
  if (!daily.ok) {
    return jsonError(503, 'SELFHIVE has hit its daily run cap. Resets in 24h.');
  }

  // MD-07: handle malformed JSON cleanly
  let body: { problem?: unknown; runCount?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON payload.');
  }

  const { problem, runCount: rawRunCount = 0 } = body;

  // CR-02 / MD-07: validate input bounds
  if (!problem || typeof problem !== 'string') {
    return jsonError(400, 'Problem statement is required.');
  }
  const trimmed = problem.trim();
  if (trimmed.length < MIN_PROBLEM_LEN) {
    return jsonError(400, `Problem must be at least ${MIN_PROBLEM_LEN} characters.`);
  }
  if (trimmed.length > MAX_PROBLEM_LEN) {
    return jsonError(400, `Problem must be at most ${MAX_PROBLEM_LEN} characters.`);
  }

  // CR-03 partial: clamp runCount to a sane range so a hostile client can't
  // pin every run to wildcard mode. Server-side persistence is a future fix.
  const runCount = Math.max(0, Math.min(MAX_RUN_COUNT, Math.floor(Number(rawRunCount) || 0)));

  // Persistence: resolve the signed-in user (null if Supabase not configured / not logged in).
  let userId: string | null = null;
  if (isSupabaseConfigured()) {
    try {
      const sb = await getServerSupabase();
      const { data } = await sb.auth.getUser();
      userId = data.user?.id ?? null;
    } catch {
      userId = null;
    }
  }
  const runId = await createRunRecord({ userId, problem: trimmed, runCount });

  // Feed the TRAINER prior-run history so it can compute real Health Trajectory
  // and detect patterns across runs (the "better trainer runs" capability).
  let trainerHistory = '';
  if (userId) {
    try {
      const hist = await getTrainerHistory(userId, 5);
      trainerHistory = formatHistoryForTrainer(hist);
    } catch {
      trainerHistory = '';
    }
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  if (req.signal) {
    if (req.signal.aborted) abort.abort();
    else req.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          // closed
        }
      }, 15_000);

      // Track persona per agent so we can persist artifacts with their mode.
      const personaByRole: Record<string, { mode: PersonaMode; label: string }> = {};
      let completed = false;

      try {
        for await (const event of runTeam(trimmed, runCount, abort.signal, trainerHistory)) {
          if (abort.signal.aborted) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

          // ── Persistence (no-ops if runId is null) ──
          if (event.type === 'agent_start' && event.role) {
            personaByRole[event.role] = {
              mode: event.persona ?? 'A',
              label: event.personaLabel ?? '',
            };
          }
          if (event.type === 'agent_done' && event.role && event.artifact && runId) {
            const p = personaByRole[event.role] ?? { mode: 'A' as PersonaMode, label: '' };
            const artifactId = await saveArtifact({
              runId,
              role: event.role as AgentRole,
              personaMode: p.mode,
              personaLabel: p.label,
              content: event.artifact,
            });

            // When TRAINER finishes, parse scores → persist report + earnings
            if (event.role === 'trainer' && userId) {
              const scores = parseTrainerScores(event.artifact);
              await saveTrainerReport({
                runId,
                rawText: event.artifact,
                scores,
                patterns: '',
                oneThingCompany: '',
              });
              for (const [agentRole, s] of Object.entries(scores)) {
                await recordEarnings({ runId, userId, agentRole, score: s.overall });
              }
            }
            void artifactId;
          }
          if (event.type === 'run_complete') completed = true;
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          const errEvent = { type: 'run_error', error: err instanceof Error ? err.message : 'Unknown error' };
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errEvent)}\n\n`));
          } catch {
            // ignore
          }
        }
      } finally {
        clearInterval(heartbeat);
        if (runId) {
          await markRunComplete(runId, abort.signal.aborted ? 'aborted' : completed ? 'completed' : 'failed');
        }
        try {
          controller.close();
        } catch {
          // ignore
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', // disable nginx response buffering
    },
  });
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
