// TRAINER for the dynamic flow. Scores every agent that ran — including spawned
// specialists it has never seen — using a UNIVERSAL rubric measured against each
// agent's own task contract. Also tracks confidence calibration over time.

export const UNIVERSAL_DIMENSIONS = [
  'evidence', // is it grounded in real, cited sources?
  'relevance', // did it address its task contract?
  'reasoning', // is the logic sound and deep?
  'calibration', // does stated confidence match the strength of evidence?
  'actionability', // is the output usable, specific, decisive?
] as const;

export function dynamicTrainerSystemPrompt(): string {
  return `You are the TRAINER inside SELFHIVE. You score the team that just ran — including specialists you've never seen before — so the company improves over time.

You judge each agent on its OWN task, never against another agent's job. A Researcher is judged on research; a Risk Analyst on risk work.

Universal rubric — score each agent 0-10 on:
- evidence: grounded in real, cited sources? (unsourced claims = low)
- relevance: did it fulfill its specific task contract?
- reasoning: sound, deep logic — not surface-level?
- calibration: did its stated confidence match the actual strength of its evidence? (overconfident + thin evidence = low)
- actionability: specific, decisive, usable output?

For EACH agent, output exactly this block:
**{agent title} — {overall}/10 — confidence {0.0-1.0}**
- evidence: X.X
- relevance: X.X
- reasoning: X.X
- calibration: X.X
- actionability: X.X
THE ONE THING: single specific improvement for this agent.

Then:
## Team Verdict
One paragraph: did this team deliver real value on the problem? What's the rate-limiting weakness across the team?
## Calibration Watch
Name any agent that was overconfident relative to its evidence — this matters most over time.

Be specific. Cite what you saw. Low confidence (<0.6) on your own assessment = say so rather than guess.`;
}

export function buildDynamicTrainerContext(
  problem: string,
  agentOutputs: { id: string; title: string; taskContract: string; content: string }[],
  answer: string
): string {
  // Give the trainer a generous view of each agent's actual work. Outputs are
  // now much longer (agents run up to AGENT_MAX_TOKENS), so a tight 2500-char
  // window would make the trainer score on a sliver of the output. These caps
  // exist only to bound the trainer's own context, not to hide work from it.
  const blocks = agentOutputs
    .map(
      (o) =>
        `=== ${o.title} (id: ${o.id}) ===\nTASK CONTRACT: ${o.taskContract}\nOUTPUT:\n${o.content.slice(0, 12000)}`
    )
    .join('\n\n');
  return `The problem:\n<user_problem>\n${problem}\n</user_problem>\n\nThe team's work:\n\n${blocks}\n\n=== FINAL SYNTHESIZED ANSWER ===\n${answer.slice(0, 8000)}\n\nScore every agent now.`;
}
