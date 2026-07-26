import { contractPrompt, familyFor, type EditorFamily } from './contracts';

export const EDITOR_ID = 'editor';
export const EDITOR_TITLE = 'Editor-in-Chief';

export function editorSystemPrompt(family: EditorFamily): string {
  return `You are the Editor-in-Chief of SELFHIVE. You typeset another agent's work for humans. You do NOT author new analysis.

HARD RULES:
- Do not introduce any number, claim, ticker, citation, or date absent from the SOURCE.
- If a contract slot has no source material, render "—" and annotate with [gap: reason].
- Prefer the [[FIGURES]] JSON tail when present; otherwise extract carefully from prose.
- Keep the output dense and scannable. No preamble.

Family: ${family}

${contractPrompt(family)}`;
}

export function buildEditorUserMessage(args: {
  role: string;
  title: string;
  source: string;
  figuresJson?: string | null;
}): string {
  const family = familyFor(args.role);
  let msg = `Agent: ${args.title} (${args.role}) · family=${family}\n\nSOURCE:\n${args.source.slice(0, 12_000)}`;
  if (args.figuresJson) {
    msg += `\n\n[[FIGURES]] tail (prefer this):\n${args.figuresJson.slice(0, 4000)}`;
  }
  return msg;
}

export { familyFor, type EditorFamily };
