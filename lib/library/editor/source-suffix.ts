/**
 * Ask financial-family producers to emit a [[FIGURES]] JSON tail the Editor
 * can prefer over prose extraction.
 */
export const FIGURES_PROMPT_SUFFIX = `

After your prose, append a machine-readable block (the UI hides it):
[[FIGURES]]
{"figures":[{"label":"...","value":"...","unit":"...","source":"...","asOf":"YYYY-MM-DD"}],"positions":[{"instrument":"...","action":"...","size":"...","entry":"...","target":"...","stop":"..."}]}
[[/FIGURES]]
Only include figures and positions grounded in your analysis. Omit the block if none.
`;

export function stripFiguresTail(text: string): string {
  return text.replace(/\n?\[\[FIGURES\]\][\s\S]*?\[\[\/FIGURES\]\]\s*$/m, '').trimEnd();
}

export function extractFiguresTail(text: string): { prose: string; json: string | null } {
  const m = text.match(/\[\[FIGURES\]\]\s*([\s\S]*?)\s*\[\[\/FIGURES\]\]/);
  if (!m) return { prose: text, json: null };
  return { prose: stripFiguresTail(text), json: m[1].trim() };
}
