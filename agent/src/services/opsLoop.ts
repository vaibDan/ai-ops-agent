import { Alert, AlertmanagerPayload, IncidentRecord, OpsContext } from "../types/index.js";
import { fetchMetricsSnapshot } from "./prometheus.js";
import {
  getContainerLogs,
  restartContainer,
  rollbackDeployment,
  scaleUp,
  getPodRestartInfo,
} from "./kubernetes.js";
import { diagnose, generatePostMortem } from "./agent.js";
import { escalate } from "./escalation.js";
import { saveIncident, generateIncidentId } from "./incidentLog.js";
import { logger } from "../utils/logger.js";

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || "0.8");

// ── Deduplication ─────────────────────────────────────────────────────────
// Two layers:
//
// 1. inFlight (fingerprint-based) — blocks concurrent processing of the
//    exact same alert fingerprint while an ops loop is still running.
//
// 2. alertCooldown (alert-name based) — blocks re-processing the same
//    alert type within ALERT_COOLDOWN_MS, even if fingerprints differ.
//    This is what prevents PodCrashLooping from burning LLM quota when
//    pods keep restarting and generating new fingerprints each time.
//
// Default cooldown: 10 minutes. Tune via ALERT_COOLDOWN_MS env var.
const ALERT_COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS || "600000", 10);

const inFlight = new Set<string>();
const alertCooldown = new Map<string, number>(); // alertName → last processed epoch ms

export async function handleAlertPayload(payload: AlertmanagerPayload): Promise<void> {
  const firingAlerts = payload.alerts.filter((a) => a.status === "firing");

  if (firingAlerts.length === 0) {
    logger.info("Received resolved notification — no action needed");
    return;
  }

  await Promise.allSettled(firingAlerts.map(processAlert));
}

async function processAlert(alert: Alert): Promise<void> {
  const fingerprint = alert.fingerprint;
  const alertName = alert.labels.alertname || "UnknownAlert";
  const cooldownKey = `${alertName}:${alert.labels.service || "unknown"}`;

  // Layer 1 — fingerprint dedup (same exact alert already running)
  if (inFlight.has(fingerprint)) {
    logger.info("Alert already in-flight, skipping", { fingerprint });
    return;
  }

  // Layer 2 — cooldown dedup (same alert type fired again too soon)
  const lastProcessed = alertCooldown.get(cooldownKey) ?? 0;
  const msSinceLast = Date.now() - lastProcessed;
  if (lastProcessed > 0 && msSinceLast < ALERT_COOLDOWN_MS) {
    logger.info("Alert in cooldown — skipping", {
      alertName,
      cooldownKey,
      remainingSecs: Math.ceil((ALERT_COOLDOWN_MS - msSinceLast) / 1000),
    });
    return;
  }

  inFlight.add(fingerprint);
  alertCooldown.set(cooldownKey, Date.now());

  const incidentId = generateIncidentId();
  const startTime = Date.now();
  const service = alert.labels.service || "sample-app";

  logger.info("── Processing alert ──────────────────────────", {
    incidentId, alertName, service, severity: alert.labels.severity,
  });

  try {
    // ── 1. OBSERVE ────────────────────────────────────────────────────────
    logger.info("Step 1/4 — Fetching metrics and logs", { incidentId });

    const isCrashLoop = alertName === "PodCrashLooping";

    const [metrics, recentLogs, restartInfo] = await Promise.all([
      fetchMetricsSnapshot(),
      getContainerLogs(service, 50),
      // Only fetch restart info for crash loop alerts — saves an API call otherwise
      isCrashLoop ? getPodRestartInfo(service) : Promise.resolve([]),
    ]);

    // For crash loops, prepend restart info as structured log lines so
    // Gemini sees exit codes and termination reasons alongside app logs.
    const enrichedLogs = isCrashLoop && restartInfo.length > 0
      ? [
        "=== POD RESTART INFO ===",
        ...restartInfo.map((r) =>
          `pod=${r.podName} restarts=${r.restartCount} ` +
          `lastState=${r.lastState} exitCode=${r.lastExitCode} ` +
          `reason=${r.lastReason}` +
          (r.lastMessage ? ` message=${r.lastMessage}` : "")
        ),
        "=== APP LOGS ===",
        ...recentLogs,
      ]
      : recentLogs;

    const ctx: OpsContext = {
      alert: {
        name: alertName,
        severity: alert.labels.severity || "unknown",
        service,
        summary: alert.annotations.summary || "",
        description: alert.annotations.description || "",
        actionHint: alert.labels.action_hint || "",
        firedAt: alert.startsAt,
      },
      metrics,
      recentLogs: enrichedLogs,
    };

    // ── 2. DIAGNOSE ───────────────────────────────────────────────────────
    logger.info("Step 2/4 — Calling Gemini for diagnosis", { incidentId });
    const diagnosis = await diagnose(ctx);

    logger.info("Gemini diagnosis received", {
      incidentId,
      action: diagnosis.action,
      confidence: diagnosis.confidence,
      diagnosis: diagnosis.diagnosis,
    });

    // ── 3. ACT ────────────────────────────────────────────────────────────
    logger.info("Step 3/4 — Executing action", {
      incidentId,
      action: diagnosis.action,
      confidence: diagnosis.confidence,
      threshold: CONFIDENCE_THRESHOLD,
    });

    let actionResult: string;
    let status: IncidentRecord["status"];

    const shouldAct =
      diagnosis.confidence >= CONFIDENCE_THRESHOLD &&
      diagnosis.action !== "escalate" &&
      diagnosis.action !== "no_action";

    if (!shouldAct) {
      await escalate(ctx, diagnosis, incidentId);
      actionResult = `Escalated — confidence ${(diagnosis.confidence * 100).toFixed(0)}% below threshold ${(CONFIDENCE_THRESHOLD * 100).toFixed(0)}%`;
      status = diagnosis.action === "no_action" ? "resolved" : "escalated";
    } else {
      try {
        actionResult = await executeAction(diagnosis, ctx);
        status = "remediated";
        logger.info("Remediation complete", { incidentId, actionResult });
      } catch (err) {
        actionResult = `Action failed: ${String(err)}`;
        status = "failed";
        logger.error("Remediation failed", { incidentId, err: String(err) });
        await escalate(ctx, { ...diagnosis, escalation_message: actionResult }, incidentId);
      }
    }

    // ── 4. RECORD ─────────────────────────────────────────────────────────
    logger.info("Step 4/4 — Recording incident", { incidentId });
    const postMortem = await generatePostMortem(ctx, diagnosis, actionResult);

    const record: IncidentRecord = {
      id: incidentId,
      timestamp: new Date().toISOString(),
      alert: ctx.alert,
      metrics,
      diagnosis,
      status,
      actionTaken: diagnosis.action,
      actionResult,
      postMortem,
      durationMs: Date.now() - startTime,
    };

    saveIncident(record);

    logger.info("── Incident closed ───────────────────────────", {
      incidentId, status, durationMs: record.durationMs,
    });
  } catch (err) {
    logger.error("Unhandled error in ops loop", { incidentId, err: String(err) });
  } finally {
    inFlight.delete(fingerprint);
  }
}

async function executeAction(
  diagnosis: {
    action: string;
    rollback_target?: string;
    scale_replicas?: number;
  },
  ctx: OpsContext
): Promise<string> {
  const service = ctx.alert.service;

  switch (diagnosis.action) {
    case "restart_container":
      return await restartContainer(service);

    case "rollback": {
      const target = diagnosis.rollback_target;
      if (!target) {
        throw new Error(
          "Gemini recommended rollback but provided no rollback_target image tag. " +
          "Ensure the system prompt includes rollback_target in its schema."
        );
      }
      return await rollbackDeployment(service, target);
    }

    case "scale_up": {
      const replicas = diagnosis.scale_replicas ?? 2;
      return await scaleUp(service, replicas);
    }

    case "reroute":
      return `Reroute requested for ${service} — requires ALB/ingress rule update`;

    case "no_action":
      return "No action taken — condition assessed as self-healing";

    default:
      throw new Error(`Unknown action: ${diagnosis.action}`);
  }
}