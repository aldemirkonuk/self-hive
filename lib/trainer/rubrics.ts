// Per-agent scoring rubrics. Each agent gets 4-5 dimensions specific to their role.
// TRAINER references these explicitly when producing scores.

export const RUBRICS: Record<string, { dimensions: string[]; weight: Record<string, number> }> = {
  pm: {
    dimensions: ['specificity', 'scope', 'priority', 'criteria', 'users'],
    weight: { specificity: 0.25, scope: 0.2, priority: 0.2, criteria: 0.2, users: 0.15 },
  },
  cto: {
    dimensions: ['archfit', 'risk', 'tradeoff', 'depend', 'security'],
    weight: { archfit: 0.25, risk: 0.2, tradeoff: 0.2, depend: 0.2, security: 0.15 },
  },
  engineer: {
    dimensions: ['correctness', 'tests', 'style', 'perf', 'errors'],
    weight: { correctness: 0.3, tests: 0.2, style: 0.15, perf: 0.15, errors: 0.2 },
  },
  qa: {
    dimensions: ['coverage', 'edges', 'repro', 'tone'],
    weight: { coverage: 0.3, edges: 0.3, repro: 0.2, tone: 0.2 },
  },
  ceo: {
    dimensions: ['mission', 'decisiveness', 'risk', 'clarity'],
    weight: { mission: 0.35, decisiveness: 0.25, risk: 0.2, clarity: 0.2 },
  },
};

export const RUBRIC_DESCRIPTIONS: Record<string, string> = {
  // PM
  specificity: 'How specific are the requirements? Vague language is penalized.',
  scope: 'Is the scope appropriately bounded? Too big or too small both lose points.',
  priority: 'Are P0 features genuinely the highest leverage choices?',
  criteria: 'Are acceptance criteria testable, not subjective?',
  users: 'Are target users specific people with real needs, not demographics?',

  // CTO
  archfit: "Does the architecture actually fit the PRD's requirements?",
  risk: 'Are technical risks named explicitly, not hidden?',
  tradeoff: 'Are stack choices defended with clear tradeoffs?',
  depend: 'Are external dependencies acknowledged and justified?',
  security: 'Are security considerations addressed concretely?',

  // ENGINEER
  correctness: 'Does the code actually do what was specified?',
  tests: 'Is there real test coverage, not just claims of testability?',
  style: 'Is the code readable and consistent?',
  perf: 'Are performance considerations addressed where relevant?',
  errors: 'Is error handling real, not bare catches?',

  // QA
  coverage: 'Does the test plan address the critical paths?',
  edges: 'Are edge cases identified that the engineer missed?',
  repro: 'Are failure modes reproducible from the description?',
  tone: 'Is feedback specific and actionable, not vague?',

  // CEO
  mission: 'Did the verdict evaluate against EXPOSURE + OUTPUT QUALITY?',
  decisiveness: 'Was a clear call made — ship, cut, or escalate?',
  clarity: 'Is the executive verdict actually clear, not hedged?',
};
