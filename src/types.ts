import type { ServerWebSocket } from "bun";
import type { MawEngine } from "./engine";

export type { MawEngine };
export type WSData = { target: string | null; previewTargets: Set<string>; mode?: "pty" };
export type MawWS = ServerWebSocket<WSData>;
export type Handler = (ws: MawWS, data: any, engine: MawEngine) => void | Promise<void>;
