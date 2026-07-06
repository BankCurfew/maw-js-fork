import { useState, useEffect, useCallback } from "react";
import { apiUrl } from "../lib/api";
import type {
  FederationConfig,
  FederationStatus,
  FederatedAgent,
} from "../lib/federation";

interface UseFederationData {
  /** Current node name (null until loaded) */
  localNode: string | null;
  /** All agents across all nodes */
  agents: FederatedAgent[];
  /** Peer reachability status */
  peers: FederationStatus["peers"];
  /** Whether federation data is loading */
  loading: boolean;
  /** Whether federation is available (API responded) */
  available: boolean;
  /** Re-fetch all federation data */
  refresh: () => void;
}

const POLL_INTERVAL = 30_000; // refresh peer status every 30s

export function useFederationData(): UseFederationData {
  const [config, setConfig] = useState<FederationConfig | null>(null);
  const [peers, setPeers] = useState<FederationStatus["peers"]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/config"));
      if (!res.ok) throw new Error(`${res.status}`);
      const data: FederationConfig = await res.json();
      if (data.node && data.agents) {
        setConfig(data);
        setAvailable(true);
      }
    } catch {
      // Federation API not available yet (#10 not deployed)
      setAvailable(false);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/federation/status"));
      if (!res.ok) return;
      const data: FederationStatus = await res.json();
      setPeers(data.peers ?? []);
    } catch {
      // Silently fail — status is optional
    }
  }, []);

  const refresh = useCallback(() => {
    fetchConfig();
    fetchStatus();
  }, [fetchConfig, fetchStatus]);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchConfig();
      await fetchStatus();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [fetchConfig, fetchStatus]);

  // Poll peer status
  useEffect(() => {
    if (!available) return;
    const id = setInterval(fetchStatus, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [available, fetchStatus]);

  // Derive agent list from config
  const agents: FederatedAgent[] = config
    ? Object.entries(config.agents).map(([name, node]) => ({
        name,
        node,
        isLocal: node === config.node,
      }))
    : [];

  return {
    localNode: config?.node ?? null,
    agents,
    peers,
    loading,
    available,
    refresh,
  };
}
