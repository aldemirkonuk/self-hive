import Nav from '@/components/Nav';
import CreateAgentForm from '@/components/CreateAgentForm';
import { FOUNDATIONAL_ROSTER } from '@/lib/roster';
import { getServerSupabase, isSupabaseConfigured } from '@/lib/db/supabase-server';

export const dynamic = 'force-dynamic';

const TIER_LABEL: Record<string, string> = {
  governance: 'GOVERNANCE',
  leadership: 'LEADERSHIP',
  execution: 'EXECUTION',
};

interface AgentStat {
  lifetime_credits: number;
  current_tier: string;
}

export default async function TeamPage() {
  // Pull lifetime stats per agent (treasury) + any promoted specialists.
  const stats: Record<string, AgentStat> = {};
  const promoted: { agent_role: string; lifetime_credits: number; current_tier: string }[] = [];
  let customAgents: { agent_key: string; title: string; domain: string; mandate: string; color: string }[] = [];
  let signedIn = false;

  if (isSupabaseConfigured()) {
    const sb = await getServerSupabase();
    const { data } = await sb.auth.getUser();
    if (data.user) {
      signedIn = true;
      const { data: treasury } = await sb
        .from('treasury_state')
        .select('agent_role, lifetime_credits, current_tier')
        .eq('user_id', data.user.id);
      (treasury ?? []).forEach((t) => {
        stats[t.agent_role] = { lifetime_credits: t.lifetime_credits, current_tier: t.current_tier };
        if (!FOUNDATIONAL_ROSTER.some((r) => r.id === t.agent_role)) promoted.push(t);
      });
      const { data: custom } = await sb
        .from('custom_agents')
        .select('agent_key, title, domain, mandate, color')
        .eq('user_id', data.user.id)
        .eq('active', true);
      customAgents = custom ?? [];
    }
  }

  const tiers: Array<'governance' | 'leadership' | 'execution'> = ['governance', 'leadership', 'execution'];

  return (
    <div className="relative min-h-screen flex flex-col" style={{ zIndex: 1 }}>
      <Nav />
      <main className="flex-1 p-6 overflow-auto">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-start justify-between mb-5">
            <div>
              <h1 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em' }}>THE TEAM</h1>
              <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2 }}>
                The permanent roster. Specialists spawn per-problem and graduate here when they prove themselves.
              </p>
            </div>
            {signedIn && <CreateAgentForm />}
          </div>

          {tiers.map((tier) => (
            <div key={tier} className="mb-6">
              <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.14em', fontWeight: 700, marginBottom: 10 }}>
                {TIER_LABEL[tier]}
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                {FOUNDATIONAL_ROSTER.filter((a) => a.tier === tier).map((a) => {
                  const s = stats[a.id];
                  return (
                    <div key={a.id} className="rounded-lg p-4" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: a.color }} />
                          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: a.color, letterSpacing: '0.04em' }}>{a.title}</span>
                        </div>
                        {s && (
                          <span style={{ fontSize: '0.5rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--gold)' }}>
                            {s.current_tier}
                          </span>
                        )}
                      </div>
                      <p style={{ fontSize: '0.62rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>{a.mandate}</p>
                      {s && (
                        <div style={{ fontSize: '0.52rem', color: 'var(--text-dim)', marginTop: 8 }}>
                          {s.lifetime_credits.toLocaleString()} lifetime credits
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Founder-created custom agents */}
          <div className="mb-6">
            <div style={{ fontSize: '0.55rem', color: '#a855f7', letterSpacing: '0.14em', fontWeight: 700, marginBottom: 10 }}>
              YOUR CUSTOM AGENTS <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· the Chief of Staff deploys these when relevant</span>
            </div>
            {customAgents.length === 0 ? (
              <div className="rounded-lg p-5 text-center" style={{ background: 'var(--bg-panel)', border: '1px dashed rgba(168,85,247,0.3)' }}>
                <p style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
                  None yet. Use “+ Create an Agent” above — you define it, the Chief of Staff decides when to use it.
                </p>
              </div>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                {customAgents.map((c) => (
                  <div key={c.agent_key} className="rounded-lg p-3" style={{ background: 'var(--bg-panel)', border: '1px solid rgba(168,85,247,0.25)' }}>
                    <div className="flex items-center gap-2 mb-1">
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: c.color }} />
                      <span style={{ fontSize: '0.66rem', fontWeight: 700, color: c.color }}>{c.title}</span>
                      <span style={{ fontSize: '0.48rem', color: 'var(--text-dim)' }}>{c.domain}</span>
                    </div>
                    <p style={{ fontSize: '0.58rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{c.mandate}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Promoted specialists */}
          <div className="mb-6">
            <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.14em', fontWeight: 700, marginBottom: 10 }}>
              PROMOTED SPECIALISTS
            </div>
            {promoted.length === 0 ? (
              <div className="rounded-lg p-5 text-center" style={{ background: 'var(--bg-panel)', border: '1px dashed var(--border)' }}>
                <p style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
                  No specialists promoted yet. Spawned agents that score &gt;0.82 across 5 appearances graduate here.
                </p>
              </div>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                {promoted.map((p) => (
                  <div key={p.agent_role} className="rounded-lg p-3" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-primary)' }}>{p.agent_role}</div>
                    <div style={{ fontSize: '0.52rem', color: 'var(--gold)', marginTop: 4 }}>{p.current_tier} · {p.lifetime_credits.toLocaleString()} cr</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
