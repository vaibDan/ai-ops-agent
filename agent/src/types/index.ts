// ── Alertmanager webhook payload ───────────────────────────────────────────
export interface AlertmanagerPayload {
  version: string;
  groupKey: string;
  truncatedAlerts: number;
  status: "firing" | "resolved";
  receiver: string;
  groupLabels: Record<string, string>;
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
  externalURL: string;
  alerts: Alert[];
}

export interface Alert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL: string;
  fingerprint: string;
}

// ── Metrics snapshot fetched from Prometheus ──────────────────────────────
export interface MetricsSnapshot {
  errorRate: number | null;       // 0–1
  requestRate: number | null;     // req/s
  p95Latency: number | null;      // seconds
  cpuUsage: number | null;        // raw process_cpu_seconds_total
  appUp: boolean;
  restartCount: number | null; 
  queriedAt: string;
}

// ── Context window sent to Claude ─────────────────────────────────────────
export interface OpsContext {
  alert: {
    name: string;
    severity: string;
    service: string;
    summary: string;
    description: string;
    actionHint: string;
    firedAt: string;
  };
  metrics: MetricsSnapshot;
  recentLogs: string[];           // last N log lines from container
}

// ── Claude's structured response ──────────────────────────────────────────
export type RemediationAction =
  | "restart_container"
  | "scale_up"
  | "rollback"
  | "reroute"
  | "escalate"
  | "no_action";

export interface ClaudeDiagnosis {
  diagnosis: string;              // Root cause explanation
  action: RemediationAction;
  confidence: number;             // 0.0–1.0
  reasoning: string;              // Step-by-step chain of thought
  rollback_target?: string;       // Image tag to roll back to, if applicable
  scale_replicas?: number;        // Target replica count, if scaling
  escalation_message?: string;    // Human-readable message for PagerDuty/Slack
}

// ── Incident record written to disk ───────────────────────────────────────
export type IncidentStatus =
  | "remediated"
  | "escalated"
  | "failed"
  | "resolved";

export interface IncidentRecord {
  id: string;
  timestamp: string;
  alert: OpsContext["alert"];
  metrics: MetricsSnapshot;
  diagnosis: ClaudeDiagnosis;
  status: IncidentStatus;
  actionTaken: string;
  actionResult?: string;
  postMortem?: string;
  durationMs: number;
}
