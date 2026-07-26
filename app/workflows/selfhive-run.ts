import type { Specialist } from '@/lib/library/specialists';
import { PlannedAgent, TeamPlan, computeExecutionLayers } from '@/lib/library/chief-of-staff';
import type { ResourceBundle } from '@/lib/resources/runtime';

type Outputs = Record<string, { title: string; content: string }>;

export interface WorkflowInput {
  runId: string;
  problem: string;
  userId: string | null;
  trainerHistory: string;
  customAgents: Record<string, Specialist>;
  costByClass: Record<string, number>;
  resourceBundle?: ResourceBundle;
  reputationBlock?: string; // HIVE ECONOMY: earned per-role standing for the CoS
  recallBlock?: string; // HIVE MIND: past episodes most like this problem, illuminated
}

/**
 * The durable SELFHIVE run. Each `await` of a step is a separate, bounded
 * function invocation — so the whole run spans well past the 300s cap and
 * survives deployments/crashes. The 'use workflow' body must stay pure (no
 * Node modules); all Node-heavy work is dynamically imported INSIDE steps.
 */
type Cost = { usd: number; in: number; out: number };
const sum = (a: Cost, b: Cost): Cost => ({ usd: a.usd + b.usd, in: a.in + b.in, out: a.out + b.out });

export async function runSelfhiveWorkflow(input: WorkflowInput) {
  'use workflow';

  try {
    let total: Cost = { usd: 0, in: 0, out: 0 };

    const composed = await composeStep(input.runId, input.problem, input.customAgents, input.costByClass, input.resourceBundle, input.trainerHistory, input.reputationBlock ?? '', input.recallBlock ?? '', input.userId);
    total = sum(total, composed.cost);
    const { plan, models, costMode, elastic } = composed;

    // Pure + deterministic: dependency layers from the composed plan.
    const layers = computeExecutionLayers(plan.agents);

    let outputs: Outputs = {};
    for (let i = 0; i < layers.length; i++) {
      if (elastic) {
        // Each agent runs as its OWN durable step. A SQUAD (a role with >1 lane)
        // folds (Way 1): lane 0 is the visible lead, the rest run suppressed and
        // fold into its single tile via leadStep. Singletons use layerStep([a]).
        const byRole = new Map<string, PlannedAgent[]>();
        for (const a of layers[i]) {
          const arr = byRole.get(a.role) ?? [];
          arr.push(a);
          byRole.set(a.role, arr);
        }
        const results = await Promise.all([...byRole.values()].map((lanes) =>
          lanes.length > 1
            ? leadStep(
                input.runId, input.problem, lanes[0], lanes.slice(1), outputs, models,
                input.customAgents, input.resourceBundle, input.userId, plan.classification,
              )
            : layerStep(
                input.runId, input.problem, [lanes[0]], outputs, models, input.customAgents,
                input.resourceBundle, input.userId, plan.classification,
              ),
        ));
        for (const res of results) {
          outputs = { ...outputs, ...res.outputs };
          total = sum(total, res.cost);
        }
      } else {
        const layerRes = await layerStep(
          input.runId, input.problem, layers[i], outputs, models, input.customAgents, input.resourceBundle,
          input.userId, plan.classification,
        );
        outputs = { ...outputs, ...layerRes.outputs };
        total = sum(total, layerRes.cost);
      }
    }

    // BACKFIRE: one bounded, CFO-gated reinforcement round if any specialist signalled
    // it couldn't finish. Folds reinforcements into the plan so the critic, synthesizer,
    // trainer and self-staffing loop all see them.
    const reinforced = await reinforceStep(
      input.runId, input.problem, plan, outputs, input.customAgents, input.resourceBundle,
      costMode, input.userId, plan.classification,
    );
    outputs = { ...outputs, ...reinforced.outputs };
    total = sum(total, reinforced.cost);
    if (reinforced.newAgents.length) plan.agents = [...plan.agents, ...reinforced.newAgents];

    // EDITOR: presentation layer (non-destructive). Critic/synth still see raw.
    const formatted = await formatStep(
      input.runId,
      plan.agents.map((a) => ({ id: a.id, role: a.role, title: a.title })),
      outputs,
      input.userId,
    );
    total = sum(total, formatted.cost);

    // ELASTIC reduce: collapse each squad into one briefing so the critic + synth
    // see bounded context. No-op (pass-through) when the flag is off. The TRAINER
    // still scores the full per-lane `outputs`.
    const reduced = await reduceStep(input.runId, plan, outputs);
    total = sum(total, reduced.cost);

    const crit = await criticStep(input.runId, input.problem, reduced.outputs, input.resourceBundle, input.userId, plan.classification);
    total = sum(total, crit.cost);
    const synth = await synthesizeStep(input.runId, input.problem, reduced.outputs, crit.critique, plan.isRegulatedFinance, input.resourceBundle, input.userId);
    total = sum(total, synth.cost);

    // EDITOR final pass on the synthesized answer (what humans read by default).
    const formatFinal = await formatStep(
      input.runId,
      [],
      {},
      input.userId,
      synth.answer,
    );
    total = sum(total, formatFinal.cost);

    const train = await trainerStep(input.runId, input.problem, plan, outputs, synth.answer, input.trainerHistory, input.resourceBundle, input.userId);
    total = sum(total, train.cost);

    // Auto-mutation loop: distill trainer advice → store as overlays → promote pins.
    // Non-fatal if it fails — finalize still runs and the answer is delivered.
    await distillStep(input.runId, input.userId, input.problem, plan.classification, plan.agents.map((a) => ({ id: a.id, role: a.role, title: a.title })), train.report);

    // HIVE IMMUNE SYSTEM: distill the critic's critique into reusable antibodies the
    // critic screens against on future runs. Non-fatal — the answer is already delivered.
    await immunizeStep(input.runId, input.userId, input.problem, plan.classification, crit.critique);

    await finalizeStep(input.runId, input.userId, plan, synth.answer, train.report, total);
    return { ok: true, costUsd: total.usd };
  } catch (err) {
    // LO-01: a thrown step would otherwise leave the run stuck at 'running'.
    await failStep(input.runId, err instanceof Error ? err.message : 'workflow failed');
    return { ok: false };
  }
}

// ── Durable step boundaries — Node-heavy impl is dynamically imported here ──
async function composeStep(runId: string, problem: string, customAgents: Record<string, Specialist>, costByClass: Record<string, number>, bundle?: ResourceBundle, trainerHistory?: string, reputationBlock?: string, recallBlock?: string, userId?: string | null) {
  'use step';
  const { composeImpl } = await import('@/lib/jobs/step-impl');
  return composeImpl(runId, problem, customAgents, costByClass, bundle, trainerHistory, reputationBlock ?? '', recallBlock ?? '', userId ?? null);
}
// ELASTIC (Way 1): a folded squad — lead (lane 0) + suppressed sub-team that
// folds into the lead's single tile. Its own durable step.
async function leadStep(
  runId: string, problem: string, lead: PlannedAgent, subLanes: PlannedAgent[], prior: Outputs,
  models: Record<string, string>, customAgents: Record<string, Specialist>, bundle?: ResourceBundle,
  userId?: string | null, classification?: string,
) {
  'use step';
  const { runLeadImpl } = await import('@/lib/jobs/step-impl');
  return runLeadImpl(runId, problem, lead, subLanes, prior, models, customAgents, bundle, userId ?? null, classification ?? null);
}
// ELASTIC (P1): reduce squads → bounded context for critic/synth. Pass-through
// when the flag is off, so the off-path is unchanged.
async function reduceStep(runId: string, plan: TeamPlan, outputs: Outputs): Promise<{ outputs: Outputs; cost: Cost }> {
  'use step';
  const { isElastic } = await import('@/lib/elastic/p1');
  if (!isElastic()) return { outputs, cost: { usd: 0, in: 0, out: 0 } };
  const { reduceImpl } = await import('@/lib/jobs/step-impl');
  return reduceImpl(runId, plan, outputs);
}
async function layerStep(
  runId: string, problem: string, layer: PlannedAgent[], prior: Outputs,
  models: Record<string, string>, customAgents: Record<string, Specialist>, bundle?: ResourceBundle,
  userId?: string | null, classification?: string,
) {
  'use step';
  const { runLayerImpl } = await import('@/lib/jobs/step-impl');
  return runLayerImpl(runId, problem, layer, prior, models, customAgents, bundle, userId ?? null, classification ?? null);
}
async function distillStep(
  runId: string, userId: string | null, problem: string,
  classification: string, planAgents: { id: string; role: string; title: string }[], trainerReport: string,
) {
  'use step';
  const { distillImpl } = await import('@/lib/jobs/step-impl');
  return distillImpl(runId, userId, problem, classification, planAgents, trainerReport);
}
async function reinforceStep(
  runId: string, problem: string, plan: TeamPlan, outputs: Outputs,
  customAgents: Record<string, Specialist>, bundle: ResourceBundle | undefined,
  costMode: boolean, userId: string | null, classification: string,
) {
  'use step';
  const { reinforceImpl } = await import('@/lib/jobs/step-impl');
  return reinforceImpl(runId, problem, plan, outputs, customAgents, bundle, costMode, userId ?? null, classification);
}
async function formatStep(
  runId: string,
  agents: { id: string; role: string; title: string }[],
  outputs: Outputs,
  userId?: string | null,
  finalAnswer?: string,
) {
  'use step';
  const { formatImpl } = await import('@/lib/jobs/step-impl');
  return formatImpl(runId, agents, outputs, userId ?? null, { finalAnswer });
}
async function criticStep(runId: string, problem: string, outputs: Outputs, bundle?: ResourceBundle, userId?: string | null, classification?: string) {
  'use step';
  const { criticImpl } = await import('@/lib/jobs/step-impl');
  return criticImpl(runId, problem, outputs, bundle, userId ?? null, classification ?? null);
}
async function immunizeStep(runId: string, userId: string | null, problem: string, classification: string, critique: string) {
  'use step';
  const { immunizeImpl } = await import('@/lib/jobs/step-impl');
  return immunizeImpl(runId, userId, problem, classification, critique);
}
async function synthesizeStep(runId: string, problem: string, outputs: Outputs, critique: string, isRegulated: boolean, bundle?: ResourceBundle, userId?: string | null) {
  'use step';
  const { synthesizeImpl } = await import('@/lib/jobs/step-impl');
  return synthesizeImpl(runId, problem, outputs, critique, isRegulated, bundle, userId ?? null);
}
async function trainerStep(runId: string, problem: string, plan: TeamPlan, outputs: Outputs, answer: string, history: string, bundle?: ResourceBundle, userId?: string | null) {
  'use step';
  const { trainerImpl } = await import('@/lib/jobs/step-impl');
  return trainerImpl(runId, problem, plan, outputs, answer, history, bundle, userId ?? null);
}
async function finalizeStep(runId: string, userId: string | null, plan: TeamPlan, answer: string, report: string, totalCost: Cost) {
  'use step';
  const { finalizeImpl } = await import('@/lib/jobs/step-impl');
  return finalizeImpl(runId, userId, plan, answer, report, totalCost);
}
async function failStep(runId: string, error: string) {
  'use step';
  const { failRunImpl } = await import('@/lib/jobs/step-impl');
  return failRunImpl(runId, error);
}
