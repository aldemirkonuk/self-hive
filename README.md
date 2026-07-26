# SELFHIVE

Autonomous AI company — Next.js + Supabase + Anthropic.

## Env

| Variable | Notes |
|---|---|
| `AI_ENABLED` | Set to `false` to freeze all Claude API calls. Default on if unset. |
| `ANTHROPIC_API_KEY` | Required when AI is enabled |
| `ELASTIC_WORKFORCE` | `true` enables budget-granted elastic squads |

Copy secrets into `.env.local`. Apply migrations under `supabase/migrations/` (0009–0012 add cost spine, curriculum, change requests, formatted artifacts).

## Getting Started

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). See `docs/ROADMAP.md` for the chronological plan.
