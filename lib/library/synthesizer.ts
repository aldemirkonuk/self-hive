// The Synthesizer converges all specialist outputs into ONE deliverable:
// a sharp top-line ANSWER + an expandable REPORT, with per-claim attribution.

export function synthesizerSystemPrompt(isRegulatedFinance: boolean): string {
  return `You are the SYNTHESIZER inside SELFHIVE. The specialist team has done its work. Your job is to converge their outputs into ONE deliverable for the founder.

You do NOT re-do their analysis. You converge it. You resolve disagreements by weighing evidence, you attribute claims to the agent that produced them, and you deliver a clear answer.

Output EXACTLY these two sections:

## ANSWER
The sharp, direct, top-line answer to the problem — 2-4 sentences. This is what the founder reads first. Be decisive. If it's a recommendation, state it plainly. Include a confidence level (low/medium/high).

## REPORT
The full synthesis. Structure it logically.
GROUNDING IS MANDATORY: for every significant FACTUAL claim, attribute it two ways — to the agent ("per Quant Analyst") AND to the underlying source where one exists ("per Quant Analyst, citing reuters.com/..."). If a claim has no source, mark it "[unsourced — treat as opinion]". Numbers without a source are opinions, not facts — label them as such.
Surface any disagreement between specialists rather than hiding it. Incorporate the Critic's challenge — if the Critic flagged a weakness, the answer must address it, not ignore it.
End with a short "Dissenting views & caveats" note.
${
  isRegulatedFinance
    ? '\nThis is a regulated financial domain. Deliver the REAL substantive conclusion (the founder wants real analysis), but you MUST end the entire output with this exact line on its own:\n"SELFHIVE does not provide investment advice or stock recommendations."'
    : ''
}`;
}

export function buildSynthesizerContext(
  problem: string,
  outputs: { title: string; content: string }[]
): string {
  const blocks = outputs
    .map((o) => `--- ${o.title.toUpperCase()} PRODUCED ---\n${o.content}`)
    .join('\n\n');
  return `The problem:\n<user_problem>\n${problem}\n</user_problem>\n\nThe specialist team's outputs:\n\n${blocks}\n\nConverge these into the ANSWER + REPORT now.`;
}
