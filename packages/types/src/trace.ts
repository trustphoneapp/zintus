import type { ProviderId } from "./provider-id.js";

export interface TraceAttempt {
  providerId: ProviderId;
  model: string;
  status: "success" | "fail";
  latencyMs: number;
  errorCode?: number;
  errorMessage?: string;
}

export interface RequestTrace {
  traceId: string;
  startedAt: Date;
  completedAt?: Date;
  attempts: TraceAttempt[];
  winner?: { providerId: ProviderId; model: string };
  totalLatencyMs?: number;
}
