import type { PeerStatus } from "../lib/federation";
import { nodeColor } from "../lib/federation";

interface PeerStatusPanelProps {
  localNode: string;
  peers: PeerStatus[];
}

/** Compact panel showing federation peer reachability + latency. */
export default function PeerStatusPanel({ localNode, peers }: PeerStatusPanelProps) {
  if (peers.length === 0) return null;

  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium text-white/60">Federation Peers</span>
        <span className="text-[10px] text-white/30">from {localNode}</span>
      </div>
      <div className="space-y-1.5">
        {peers.map((peer) => {
          const { accent } = nodeColor(peer.name);
          return (
            <div key={peer.name} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: peer.reachable ? "#22c55e" : "#ef4444" }}
                />
                <span className="text-sm truncate" style={{ color: accent }}>
                  {peer.name}
                </span>
              </div>
              <span className="text-[10px] text-white/40 flex-shrink-0">
                {peer.reachable
                  ? `${peer.latencyMs ?? "?"}ms`
                  : "unreachable"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
