// Shared prompt-caching helpers. Caching is a PREFIX match: any byte that
// changes anywhere in a cached block invalidates that block's entry. So the
// only way a cache breakpoint ever pays off across agent calls is if the text
// ahead of it is byte-identical between calls — which means per-run content
// (task contracts, trainer history, overlays that mutate over time) must
// never sit ahead of a breakpoint mixed in with content that's otherwise
// stable forever (doctrine, canon, a role's base system prompt).
//
// `splitCachedSystem` is the general form: STABLE prefix gets the cache
// breakpoint, VOLATILE suffix is appended uncached after it. `cachedSystem`
// is the single-block shorthand for prompts that are either fully stable or
// where splitting isn't worth the complexity (rare, low-volume calls).
//
// TTL choice: `1h` costs 2x to write vs `5m`'s 1.25x, so it only pays off
// once a cached entry is read 3+ times inside the window (see
// shared/prompt-caching.md § Economics in the claude-api skill). Use `1h`
// for content reused across MANY calls — a role's base prompt is identical
// for every agent of that role, in every run, all day — and `5m` (the
// default) for anything reused only within a single run (e.g. relay
// continuation rounds resending the same `system` value).

type CacheTTL = '5m' | '1h';
export type CachedSystemBlock = {
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral'; ttl?: '1h' };
};
export type UncachedSystemBlock = { type: 'text'; text: string };
export type SystemBlocks = [CachedSystemBlock] | [CachedSystemBlock, UncachedSystemBlock];

function cacheControl(ttl: CacheTTL) {
  return ttl === '1h'
    ? ({ type: 'ephemeral', ttl: '1h' } as const)
    : ({ type: 'ephemeral' } as const);
}

/** Single cached block. Use for prompts that are fully stable, or where the
 * per-run content is small/rare enough that splitting isn't worth it. */
export function cachedSystem(prompt: string, ttl: CacheTTL = '5m'): [CachedSystemBlock] {
  return [{ type: 'text', text: prompt, cache_control: cacheControl(ttl) }];
}

/** Two-block split: `stable` (identical across calls — gets the breakpoint)
 * followed by `volatile` (per-run — never invalidates the stable entry).
 * Defaults `stable` to a 1h TTL since the whole point of splitting is reuse
 * across many calls; pass `ttl: '5m'` to override. */
export function splitCachedSystem(stable: string, volatile: string, ttl: CacheTTL = '1h'): SystemBlocks {
  const head: CachedSystemBlock = { type: 'text', text: stable, cache_control: cacheControl(ttl) };
  return volatile ? [head, { type: 'text', text: volatile }] : [head];
}
