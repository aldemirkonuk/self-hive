// HIVE GENOME — the evolutionary roster. The TRAINER is already a fitness function
// and reputation (lib/library/reputation.ts) is the fitness SIGNAL. This organ closes
// the Darwinian loop: when the hive promotes a proven specialist, it BREEDS a mutated
// challenger offspring. Both compete in real runs; the trainer scores them; weak
// challengers auto-retire through the existing retirement watch, and the explicit
// duel (evolveDecision) lets a fitter challenger unseat its parent. The permanent
// roster doesn't just GROW — it EVOLVES toward fitness.
//
// PRIME DIRECTIVE: every promotion now also tries to make the hive STRONGER than the
// agent it just promoted — the staff improves generation over generation.
//
// This file is pure + self-contained (one bounded Haiku call for the actual mutation)
// so the mutation/selection logic is unit-testable without a database.

import { callModel, isAIEnabled } from '@/lib/ai/client';
import { WORKFORCE_MODEL } from './constants';

export const GENOME = {
  // A challenger must prove itself across this many scored appearances before the
  // duel can resolve — same "more than once" spirit as promotion.
  MIN_DUEL_APPEARANCES: 3,
  // The reputation margin a challenger must clear (or fall behind by) to win/lose
  // the duel decisively. Inside the margin → keep competing.
  WIN_MARGIN: 0.5,
} as const;

// The mutation "genes" — the axes a challenger can differ from its parent on. Each is
// aligned with SELFHIVE's taste (density, disagreement, decisiveness, first-principles).
export interface MutationGene {
  id: string;
  trait: string;
  directive: string;
}
export const MUTATION_GENES: readonly MutationGene[] = [
  { id: 'skeptic', trait: 'sharper skepticism', directive: 'Make it markedly more skeptical — it stress-tests its own conclusions, hunts disconfirming evidence, and refuses to round weak signals up into strong ones.' },
  { id: 'rigor', trait: 'deeper quantitative rigor', directive: 'Make it more rigorous — it shows its work and quantifies wherever possible, never hand-waving a claim it could ground in a number.' },
  { id: 'decisive', trait: 'sharper decisiveness', directive: 'Make it more decisive — it leads with a clear call and an explicit confidence level, then defends it, instead of hedging.' },
  { id: 'contrarian', trait: 'an independent, contrarian lens', directive: 'Make it more independent-minded — it actively works out the non-consensus read and names exactly where the crowd is likely wrong.' },
  { id: 'dense', trait: 'ruthless density', directive: 'Make it denser — every sentence earns its place; it never restates the prompt or pads.' },
  { id: 'firstprinciples', trait: 'first-principles depth', directive: 'Make it reason from first principles — it decomposes to fundamentals instead of pattern-matching surface analogies.' },
] as const;

// Map a weak TRAINER rubric dimension → the gene most likely to fix it. Lets breeding
// be DIRECTED by the parent's measured weakness when we know it (else we rotate).
const DIMENSION_TO_GENE: Record<string, string> = {
  evidence: 'rigor',
  calibration: 'skeptic',
  reasoning: 'firstprinciples',
  actionability: 'decisive',
  relevance: 'dense',
};

function geneById(id: string): MutationGene {
  return MUTATION_GENES.find((g) => g.id === id) ?? MUTATION_GENES[0];
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export interface ChallengerPlan {
  gene: MutationGene;
  title: string; // distinct from the parent so reputation tracks them separately
}

/**
 * Choose how to mutate a parent into a challenger. Directed by the parent's weakest
 * trainer dimension when provided; otherwise rotated deterministically by title so
 * repeated breeds explore different genes. The challenger title is kept distinct (no
 * " — " separator, which reputation strips) so the two compete as separate standings.
 */
export function planChallenger(parent: { title: string; weakestDimension?: string }): ChallengerPlan {
  const directed = parent.weakestDimension ? DIMENSION_TO_GENE[parent.weakestDimension.toLowerCase()] : undefined;
  const gene = directed ? geneById(directed) : MUTATION_GENES[hash(parent.title) % MUTATION_GENES.length];
  return { gene, title: `${parent.title} · ${gene.trait}` };
}

/** The Spawner's mutation directive — produces a mutated canonical prompt. Pure. */
export function mutateGenomePrompt(parentTitle: string, parentPrompt: string, gene: MutationGene): string {
  return `You are the SPAWNER of SELFHIVE running DIRECTED EVOLUTION. A specialist named "${parentTitle}" has earned permanent staff status. Breed a CHALLENGER offspring: same role and domain, but with one trait deliberately amplified — ${gene.trait}.

${gene.directive}

The challenger must stay a credible ${parentTitle} (do not break its core role); it is a sharper VARIANT, not a different specialist. Keep everything that made the parent strong; mutate only along the named trait.

PARENT GENOME (generalize, then mutate):
"""
${parentPrompt.slice(0, 1800)}
"""

Respond with ONLY a JSON object, no prose, no markdown fences:
{ "systemPrompt": "the full mutated system prompt", "mandate": "one-line mandate (what good output looks like)" }`;
}

export interface BredChallenger {
  geneId: string;
  title: string;
  systemPrompt: string;
  mandate: string;
}

/** Synthesize a mutated challenger from a promoted parent. One bounded Haiku call;
 *  falls back to a lightly-framed parent prompt if the model is unavailable. */
export async function breedChallenger(parent: {
  title: string;
  systemPrompt: string;
  mandate: string;
  weakestDimension?: string;
}): Promise<BredChallenger> {
  const plan = planChallenger(parent);
  const fallback: BredChallenger = {
    geneId: plan.gene.id,
    title: plan.title,
    systemPrompt: parent.systemPrompt,
    mandate: parent.mandate,
  };
  if (!isAIEnabled()) return fallback;
  try {
    const resp = await callModel(
      { role: 'genome', phase: 'promote' },
      {
        model: WORKFORCE_MODEL,
        max_tokens: 1600,
        system: mutateGenomePrompt(parent.title, parent.systemPrompt, plan.gene),
        messages: [{ role: 'user', content: 'Breed the challenger now.' }],
      },
      { maxRetries: 3, timeout: 60_000 },
    );
    const block = resp.content.find((b) => b.type === 'text');
    const raw = block && 'text' in block ? block.text : '';
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { systemPrompt?: unknown; mandate?: unknown };
    const sp = typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt.trim() : '';
    const md = typeof parsed.mandate === 'string' ? parsed.mandate.trim() : '';
    return {
      geneId: plan.gene.id,
      title: plan.title,
      systemPrompt: sp.length > 60 ? sp : fallback.systemPrompt,
      mandate: md.length > 6 ? md : fallback.mandate,
    };
  } catch {
    return fallback;
  }
}

export type EvolveOutcome = 'challenger_wins' | 'incumbent_holds' | 'keep_competing';

/**
 * The duel: given an incumbent (parent) and its challenger offspring, both tracked by
 * reputation/rolling score, decide the outcome. A challenger must prove itself across
 * MIN_DUEL_APPEARANCES and beat the incumbent by WIN_MARGIN to take the throne; if it
 * falls behind by the margin it's culled; otherwise the duel continues. Pure.
 *
 * Wired into the post-run duel pass (lib/workforce/duel.ts → resolveDuels), which compares
 * the parent vs challenger clusters' rolling scores each run. The generic retirement watch
 * remains a backstop for either side that simply rots.
 */
export function evolveDecision(args: {
  incumbentRep: number;
  challengerRep: number;
  challengerAppearances: number;
}): EvolveOutcome {
  if (args.challengerAppearances < GENOME.MIN_DUEL_APPEARANCES) return 'keep_competing';
  if (args.challengerRep >= args.incumbentRep + GENOME.WIN_MARGIN) return 'challenger_wins';
  if (args.challengerRep <= args.incumbentRep - GENOME.WIN_MARGIN) return 'incumbent_holds';
  return 'keep_competing';
}

// One side of a duel — a promoted parent or its evolved challenger, with the rolling
// score + appearances its tracking cluster has accrued.
export interface DuelParticipant {
  agentKey: string;
  title: string;
  clusterId: string;
  rolling: number;
  appearances: number;
}

export interface DuelResolution {
  outcome: Exclude<EvolveOutcome, 'keep_competing'>;
  winnerTitle: string;
  loserTitle: string;
  loserAgentKey: string;
  loserClusterId: string;
}

/**
 * Resolve a parent↔challenger duel into the loser to cull, or null to keep competing.
 * Pure — the runtime (resolveDuels) supplies the participants and applies the cull.
 */
export function duelResult(parent: DuelParticipant, challenger: DuelParticipant): DuelResolution | null {
  const outcome = evolveDecision({
    incumbentRep: parent.rolling,
    challengerRep: challenger.rolling,
    challengerAppearances: challenger.appearances,
  });
  if (outcome === 'challenger_wins') {
    return { outcome, winnerTitle: challenger.title, loserTitle: parent.title, loserAgentKey: parent.agentKey, loserClusterId: parent.clusterId };
  }
  if (outcome === 'incumbent_holds') {
    return { outcome, winnerTitle: parent.title, loserTitle: challenger.title, loserAgentKey: challenger.agentKey, loserClusterId: challenger.clusterId };
  }
  return null; // keep_competing
}
