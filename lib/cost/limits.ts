/** Output / thinking caps. Editor is deliberately cheap and short. */

export const EDITOR_MODEL = 'claude-haiku-4-5';
export const EDITOR_MAX_TOKENS = 1500;
/** Skip formatting when the source artifact is this short. */
export const EDITOR_MIN_SOURCE_CHARS = 400;

/** Financial-family + critic get extended thinking inside a raised max_tokens. */
export const PRODUCER_MAX_TOKENS = 14_000;
export const PRODUCER_THINKING_BUDGET = 6_000;

export const PROFESSOR_SESSION_CAP_USD = 1.5;
export const PROFESSOR_MODEL = 'claude-sonnet-4-5';
export const PROFESSOR_MAX_TOKENS = 4096;
