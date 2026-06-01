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

    const composed = await composeStep(input.runId, input.problem, input.customAgents, input.costByClass, input.resourceBundle, input.trainerHistory);
    total = sum(total, composed.cost);
    const { plan, models } = composed;

    // Pure + deterministic: dependency layers from the composed plan.
    const layers = computeExecutionLayers(plan.agents);

    let outputs: Outputs = {};
    for (let i = 0; i < layers.length; i++) {
      const layerRes = await layerStep(
        input.runId, input.problem, layers[i], outputs, models, input.customAgents, input.resourceBundle,
        input.userId, plan.classification,
      );
      outputs = { ...outputs, ...layerRes.outputs };
      total = sum(total, layerRes.cost);
    }

    const crit = await criticStep(input.runId, input.problem, outputs, input.resourceBundle);
    total = sum(total, crit.cost);
    const synth = await synthesizeStep(input.runId, input.problem, outputs, crit.critique, plan.isRegulatedFinance, input.resourceBundle);
    total = sum(total, synth.cost);
    const train = await trainerStep(input.runId, input.problem, plan, outputs, synth.answer, input.trainerHistory, input.resourceBundle);
    total = sum(total, train.cost);

    // Auto-mutation loop: distill trainer advice → store as overlays → promote pins.
    // Non-fatal if it fails — finalize still runs and the answer is delivered.
    await distillStep(input.runId, input.userId, input.problem, plan.classification, plan.agents.map((a) => ({ id: a.id, title: a.title })), train.report);

    await finalizeStep(input.runId, input.userId, plan, synth.answer, train.report, total);
    return { ok: true, costUsd: total.usd };
  } catch (err) {
    // LO-01: a thrown step would otherwise leave the run stuck at 'running'.
    await failStep(input.runId, err instanceof Error ? err.message : 'workflow failed');
    return { ok: false };
  }
}

// ── Durable step boundaries — Node-heavy impl is dynamically imported here ──
async function composeStep(runId: string, problem: string, customAgents: Record<string, Specialist>, costByClass: Record<string, number>, bundle?: ResourceBundle, trainerHistory?: string) {
  'use step';
  const { composeImpl } = await import('@/lib/jobs/step-impl');
  return composeImpl(runId, problem, customAgents, costByClass, bundle, trainerHistory);
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
  classification: string, planAgents: { id: string; title: string }[], trainerReport: string,
) {
  'use step';
  const { distillImpl } = await import('@/lib/jobs/step-impl');
  return distillImpl(runId, userId, problem, classification, planAgents, trainerReport);
}
async function criticStep(runId: string, problem: string, outputs: Outputs, bundle?: ResourceBundle) {
  'use step';
  const { criticImpl } = await import('@/lib/jobs/step-impl');
  return criticImpl(runId, problem, outputs, bundle);
}
async function synthesizeStep(runId: string, problem: string, outputs: Outputs, critique: string, isRegulated: boolean, bundle?: ResourceBundle) {
  'use step';
  const { synthesizeImpl } = await import('@/lib/jobs/step-impl');
  return synthesizeImpl(runId, problem, outputs, critique, isRegulated, bundle);
}
async function trainerStep(runId: string, problem: string, plan: TeamPlan, outputs: Outputs, answer: string, history: string, bundle?: ResourceBundle) {
  'use step';
  const { trainerImpl } = await import('@/lib/jobs/step-impl');
  return trainerImpl(runId, problem, plan, outputs, answer, history, bundle);
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
