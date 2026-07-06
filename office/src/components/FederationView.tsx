import { useFederationData } from "../hooks/useFederationData";
import NodeBadge from "./NodeBadge";
import PeerStatusPanel from "./PeerStatusPanel";
import { nodeColor, crossNodeTarget } from "../lib/federation";
import type { FederatedAgent } from "../lib/federation";

interface FederationViewProps {
  onSendMessage?: (target: string) => void;
}

/** Full federation dashboard: node indicator + multi-node oracle list + peer status. */
export default function FederationView({ onSendMessage }: FederationViewProps) {
  const { localNode, agents, peers, loading, available, refresh } = useFederationData();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-white/40">
        Loading federation data...
      </div>
    );
  }

  if (!available) {
    return (
      <div className="max-w-xl mx-auto py-12 text-center">
        <div className="text-white/30 text-sm mb-2">Federation API not available</div>
        <div className="text-white/20 text-xs mb-4">
          Waiting for <span className="text-white/40 font-mono">#10</span> backend endpoints.
          The UI is ready — will auto-connect when API is deployed.
        </div>
        <button
          onClick={refresh}
          className="px-3 py-1.5 text-xs rounded border border-white/10 text-white/40 hover:text-white/60 hover:border-white/20 transition-colors"
        >
          Retry connection
        </button>
      </div>
    );
  }

  // Group agents by node
  const byNode = agents.reduce<Record<string, FederatedAgent[]>>((acc, a) => {
    (acc[a.node] ??= []).push(a);
    return acc;
  }, {});

  // Sort: local node first, then alphabetical
  const nodeOrder = Object.keys(byNode).sort((a, b) => {
    if (a === localNode) return -1;
    if (b === localNode) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header: node identity + refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white/90">Federation</h2>
          {localNode && <NodeBadge node={localNode} isLocal size="md" />}
          <span className="text-xs text-white/30">
            {agents.length} oracles across {nodeOrder.length} node{nodeOrder.length !== 1 ? "s" : ""}
          </span>
        </div>
        <button
          onClick={refresh}
          className="px-2 py-1 text-xs rounded border border-white/10 text-white/40 hover:text-white/60 hover:border-white/20 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Peer status panel */}
      <PeerStatusPanel localNode={localNode!} peers={peers} />

      {/* Oracle list grouped by node */}
      <div className="space-y-4">
        {nodeOrder.map((nodeName) => {
          const nodeAgents = byNode[nodeName];
          const { accent } = nodeColor(nodeName);
          const isLocal = nodeName === localNode;
          return (
            <div
              key={nodeName}
              className="rounded-lg border overflow-hidden"
              style={{ borderColor: accent + "30" }}
            >
              {/* Node header */}
              <div
                className="px-4 py-2 flex items-center justify-between"
                style={{ backgroundColor: accent + "10" }}
              >
                <div className="flex items-center gap-2">
                  <NodeBadge node={nodeName} isLocal={isLocal} />
                  <span className="text-xs text-white/40">
                    {nodeAgents.length} oracle{nodeAgents.length !== 1 ? "s" : ""}
                  </span>
                </div>
                {/* Peer connection indicator */}
                {!isLocal && (() => {
                  const peer = peers.find((p) => p.name === nodeName);
                  if (!peer) return null;
                  return (
                    <span className="flex items-center gap-1 text-[10px] text-white/30">
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: peer.reachable ? "#22c55e" : "#ef4444" }}
                      />
                      {peer.reachable ? `${peer.latencyMs ?? "?"}ms` : "offline"}
                    </span>
                  );
                })()}
              </div>

              {/* Agent rows */}
              <div className="divide-y divide-white/[0.05]">
                {nodeAgents.sort((a, b) => a.name.localeCompare(b.name)).map((agent) => (
                  <div
                    key={agent.name}
                    className="px-4 py-2.5 flex items-center justify-between hover:bg-white/[0.03] transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Agent color dot */}
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: accent }}
                      />
                      <span className="text-sm text-white/80 truncate">
                        {agent.name}
                      </span>
                    </div>

                    {/* Send message button (cross-node) */}
                    {onSendMessage && (
                      <button
                        onClick={() =>
                          onSendMessage(crossNodeTarget(agent.node, agent.name, localNode!))
                        }
                        className="px-2 py-1 text-[10px] rounded border border-white/10 text-white/30 hover:text-white/60 hover:border-white/20 transition-colors"
                      >
                        message
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
