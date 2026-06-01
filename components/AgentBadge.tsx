import { agentBadgeIni, resolveAgentColor } from '@/lib/agent-display';

interface AgentBadgeProps {
  agent: string;
  score?: number;
  size?: number;
}

/** Compact agent chip — filled role color + hive-style initials (matches /hive nodes). */
export default function AgentBadge({ agent, score, size = 22 }: AgentBadgeProps) {
  const color = resolveAgentColor(agent);
  const ini = agentBadgeIni(agent);
  const title = score != null ? `${agent} · ${score.toFixed(1)}` : agent;

  return (
    <div
      title={title}
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: color,
        border: `1px solid color-mix(in srgb, ${color} 55%, var(--border))`,
        boxShadow: `0 0 0 1px color-mix(in srgb, ${color} 18%, transparent)`,
        fontSize: ini.length > 2 ? '0.38rem' : '0.5rem',
        fontWeight: 700,
        color: '#0a0806',
        letterSpacing: '0.02em',
        flexShrink: 0,
        lineHeight: 1,
      }}
    >
      {ini}
    </div>
  );
}
