# SELFHIVE UI sketches

Throwaway HTML explorations (not served by the app). Open in a browser:

```bash
open sketches/03-company-parallax.html
```

| File | Source | Notes |
|------|--------|--------|
| `03-company-parallax.html` | New · inspired by Downloads `01-*`, `02-trainer-panel.html` | `/company` layout + scroll parallax backgrounds + post-run trainer/treasury |
| `04-company-agents-run.html` | New · run-state focus | Four agent layout options after submit (A=prod grid, B=layers ★, C=bento, D=lanes) |
| `05-team-hive-roster.html` | New · creative /team | Live constellation map, orbit rings, promotion river, floating custom orbs, tier cards with 3D tilt |

**Implemented in app:** sketch **C (bento)** + continuous telemetry → `components/company/CompanyBentoBoard.tsx` on `/company`.

External reference pack (user Downloads):

- `01-pipeline-layouts.html` — pipeline grid morphs → implemented on `/pipeline` via `TrainerPanel` + morph layout
- `02-trainer-panel.html` — radial scorecards + treasury sidebar → **partially** in `components/TrainerPanel.tsx` (`/pipeline` only)
- `06-hierarchy.html` → `/hive` (`HierarchyStage`)
- `07-resources.html` → `/resources` (shelf tiles)
