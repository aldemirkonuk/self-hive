import { isAIEnabled } from '@/lib/ai/flags';

/** Persistent amber strip when Claude is paused. Server-rendered — never ambiguous. */
export default function AiPausedBanner() {
  if (isAIEnabled()) return null;
  return (
    <div
      role="status"
      style={{
        flexShrink: 0,
        background: 'rgba(245, 158, 11, 0.12)',
        borderBottom: '1px solid rgba(245, 158, 11, 0.35)',
        color: '#f59e0b',
        fontSize: '0.58rem',
        fontWeight: 700,
        letterSpacing: '0.14em',
        textAlign: 'center',
        padding: '7px 12px',
        fontFamily: 'inherit',
      }}
    >
      AI PAUSED — NO API CALLS WILL BE MADE
    </div>
  );
}
