/**
 * AI kill switch. Off when AI_ENABLED is exactly the string "false"
 * (case-insensitive, trimmed). Any other value (including unset) = on.
 */
export function isAIEnabled(): boolean {
  return (process.env.AI_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}
