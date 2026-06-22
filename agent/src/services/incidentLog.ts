import { Pool } from "pg";
import { IncidentRecord } from "../types/index.js";
import { logger } from "../utils/logger.js";

// ── Connection pool ────────────────────────────────────────────────────────
// Pool is created lazily on first use — if DATABASE_URL is not set the
// agent still works, incidents are just logged and not persisted to DB.
let pool: Pool | null = null;

function getPool(): Pool | null {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,                    // small pool — agent traffic is low
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on("error", (err) => {
      logger.error("Postgres pool error", { err: String(err) });
    });

    logger.info("Postgres pool created", {
      url: process.env.DATABASE_URL.replace(/:\/\/.*@/, "://*****@"), // mask creds in logs
    });
  }
  return pool;
}

// ── Save incident ──────────────────────────────────────────────────────────
export async function saveIncident(record: IncidentRecord): Promise<void> {
  const db = getPool();

  if (!db) {
    // DATABASE_URL not set — log only, no crash
    logger.warn("DATABASE_URL not set — incident not persisted to Postgres", {
      id: record.id,
    });
    return;
  }

  const query = `
    INSERT INTO incidents (
      id, timestamp, alert_name, alert_severity, service,
      summary, description, action_hint, fired_at,
      error_rate, request_rate, p95_latency, cpu_usage,
      restart_count, app_up,
      diagnosis, action_taken, confidence, reasoning,
      rollback_target, scale_replicas,
      status, action_result, post_mortem, duration_ms,
      llm_provider,
      raw_alert, raw_metrics, raw_diagnosis
    ) VALUES (
      $1,  $2,  $3,  $4,  $5,
      $6,  $7,  $8,  $9,
      $10, $11, $12, $13,
      $14, $15,
      $16, $17, $18, $19,
      $20, $21,
      $22, $23, $24, $25,
      $26,
      $27, $28, $29
    )
    ON CONFLICT (id) DO UPDATE SET
      status        = EXCLUDED.status,
      action_result = EXCLUDED.action_result,
      post_mortem   = EXCLUDED.post_mortem,
      duration_ms   = EXCLUDED.duration_ms
  `;

  const values = [
    // Identity
    record.id,
    record.timestamp,
    record.alert.name,
    record.alert.severity,
    record.alert.service,
    // Alert detail
    record.alert.summary || null,
    record.alert.description || null,
    record.alert.actionHint || null,
    record.alert.firedAt || null,
    // Metrics
    record.metrics.errorRate,
    record.metrics.requestRate,
    record.metrics.p95Latency,
    record.metrics.cpuUsage,
    record.metrics.restartCount,
    record.metrics.appUp,
    // Diagnosis
    record.diagnosis.diagnosis,
    record.actionTaken,
    record.diagnosis.confidence,
    record.diagnosis.reasoning || null,
    record.diagnosis.rollback_target || null,
    record.diagnosis.scale_replicas ?? null,
    // Outcome
    record.status,
    record.actionResult || null,
    record.postMortem || null,
    record.durationMs,
    // Provider — stored on diagnosis if present, fallback to null
    (record.diagnosis as unknown as Record<string, string>)["provider"] ?? null,
    // Raw JSONB blobs — useful for ad-hoc queries and future pgvector
    JSON.stringify(record.alert),
    JSON.stringify(record.metrics),
    JSON.stringify(record.diagnosis),
  ];

  try {
    await db.query(query, values);
    logger.info("Incident saved to Postgres", {
      id: record.id,
      status: record.status,
    });
  } catch (err) {
    logger.error("Failed to save incident to Postgres", {
      id: record.id,
      err: String(err),
    });
    // Don't rethrow — a DB write failure should never crash the ops loop
  }
}

// ── Load incidents ─────────────────────────────────────────────────────────
export async function loadIncidents(limit = 100): Promise<IncidentRecord[]> {
  const db = getPool();
  if (!db) return [];

  try {
    const result = await db.query<{
      id: string; timestamp: string; alert_name: string;
      alert_severity: string; service: string; summary: string;
      description: string; action_hint: string; fired_at: string;
      error_rate: string; request_rate: string; p95_latency: string;
      cpu_usage: string; restart_count: string; app_up: boolean;
      diagnosis: string; action_taken: string; confidence: string;
      reasoning: string; rollback_target: string; scale_replicas: string;
      status: string; action_result: string; post_mortem: string;
      duration_ms: number; llm_provider: string;
    }>(
      `SELECT * FROM incidents ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );

    return result.rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      alert: {
        name: r.alert_name,
        severity: r.alert_severity,
        service: r.service,
        summary: r.summary ?? "",
        description: r.description ?? "",
        actionHint: r.action_hint ?? "",
        firedAt: r.fired_at,
      },
      metrics: {
        errorRate: r.error_rate != null ? parseFloat(r.error_rate) : null,
        requestRate: r.request_rate != null ? parseFloat(r.request_rate) : null,
        p95Latency: r.p95_latency != null ? parseFloat(r.p95_latency) : null,
        cpuUsage: r.cpu_usage != null ? parseFloat(r.cpu_usage) : null,
        restartCount: r.restart_count != null ? parseInt(r.restart_count) : null,
        appUp: r.app_up,
        queriedAt: r.timestamp,
      },
      diagnosis: {
        diagnosis: r.diagnosis,
        action: r.action_taken as IncidentRecord["diagnosis"]["action"],
        confidence: parseFloat(r.confidence),
        reasoning: r.reasoning ?? "",
        rollback_target: r.rollback_target ?? undefined,
        scale_replicas: r.scale_replicas != null ? parseInt(r.scale_replicas) : undefined,
      },
      status: r.status as IncidentRecord["status"],
      actionTaken: r.action_taken,
      actionResult: r.action_result ?? "",
      postMortem: r.post_mortem ?? "",
      durationMs: r.duration_ms,
    }));
  } catch (err) {
    logger.error("Failed to load incidents from Postgres", { err: String(err) });
    return [];
  }
}

// ── Stats query ────────────────────────────────────────────────────────────
export async function getIncidentStats(): Promise<{
  total: number;
  byStatus: Record<string, number>;
  byAction: Record<string, number>;
  avgDurationMs: number;
  avgConfidence: number;
  lastIncident: string | null;
}> {
  const db = getPool();
  if (!db) {
    return {
      total: 0, byStatus: {}, byAction: {},
      avgDurationMs: 0, avgConfidence: 0, lastIncident: null,
    };
  }

  try {
    const [totals, byStatus, byAction] = await Promise.all([
      db.query<{ total: string; avg_duration: string; avg_confidence: string; last_incident: string }>(
        `SELECT
           COUNT(*)                    AS total,
           AVG(duration_ms)            AS avg_duration,
           AVG(confidence)             AS avg_confidence,
           MAX(timestamp)::TEXT        AS last_incident
         FROM incidents`
      ),
      db.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*) AS count FROM incidents GROUP BY status`
      ),
      db.query<{ action_taken: string; count: string }>(
        `SELECT action_taken, COUNT(*) AS count FROM incidents GROUP BY action_taken`
      ),
    ]);

    const t = totals.rows[0];
    return {
      total: parseInt(t.total),
      avgDurationMs: Math.round(parseFloat(t.avg_duration ?? "0")),
      avgConfidence: parseFloat((parseFloat(t.avg_confidence ?? "0")).toFixed(3)),
      lastIncident: t.last_incident ?? null,
      byStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, parseInt(r.count)])),
      byAction: Object.fromEntries(byAction.rows.map((r) => [r.action_taken, parseInt(r.count)])),
    };
  } catch (err) {
    logger.error("Failed to get incident stats", { err: String(err) });
    return {
      total: 0, byStatus: {}, byAction: {},
      avgDurationMs: 0, avgConfidence: 0, lastIncident: null,
    };
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info("Postgres pool closed");
  }
}

// ── ID generator (unchanged) ───────────────────────────────────────────────
export function generateIncidentId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `INC-${ts}-${rand}`;
}