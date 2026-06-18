import { Alert, AlertmanagerPayload, IncidentRecord, OpsContext } from "../types/index.js";
import { fetchMetricsSnapshot } from "./prometheus.js";
import { getPodLogs as getContainerLogs, restartDeployment as restartContainer, rollbackDeployment as rollbackContainer, scaleDeployment as scaleUp } from "./kubernetes.js";
import { diagnose, generatePostMortem } from "./agent.js";
import { escalate } from "./escalation.js";
import { saveIncident, generateIncidentId } from "./incidentLog.js";
import { logger } from "../utils/logger.js";

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || "0.8");

// Deduplicate: track in-flight alert fingerprints to avoid re-processing
const inFlight = new Set<string>();

export async function handleAlertPayload(payload: AlertmanagerPayload): Promise<void> {
  const firingAlerts = payload.alerts.filter((a) => a.status === "firing");

  if (firingAlerts.length === 0) {
    logger.info("Received resolved notification — no action needed");
    return;
  }

  // Process each alert independently (they may have different services/severities)
  await Promise.allSettled(firingAlerts.map(processAlert));
}

async function processAlert(alert: Alert): Promise<void> {
  const fingerprint = alert.fingerprint;

  if (inFlight.has(fingerprint)) {
    logger.info("Alert already in-flight, skipping", { fingerprint });
    return;
  }
  inFlight.add(fingerprint);

  const incidentId = generateIncidentId();
  const startTime = Date.now();

  logger.info("── Processing alert ──────────────────────────", {
    incidentId,
    alertName: alert.labels.alertname,
    service: alert.labels.service,
    severity: alert.labels.severity,
  });

  try {
    // ── 1. OBSERVE: build context window ──────────────────────────────────
    logger.info("Step 1/4 — Fetching metrics and logs", { incidentId });
    const [metrics, recentLogs] = await Promise.all([
      fetchMetricsSnapshot(),
      getContainerLogs(alert.labels.service || "sample-app", 40),
    ]);

    const ctx: OpsContext = {
      alert: {
        name: alert.labels.alertname || "UnknownAlert",
        severity: alert.labels.severity || "unknown",
        service: alert.labels.service || "unknown",
        summary: alert.annotations.summary || "",
        description: alert.annotations.description || "",
        actionHint: alert.labels.action_hint || "",
        firedAt: alert.startsAt,
      },
      metrics,
      recentLogs,
    };

    // ── 2. DIAGNOSE: call Gemini ───────────────────────────────────────────
    logger.info("Step 2/4 — Calling Gemini for diagnosis", { incidentId });
    const diagnosis = await diagnose(ctx);

    logger.info("Gemini diagnosis received", {
      incidentId,
      action: diagnosis.action,
      confidence: diagnosis.confidence,
      diagnosis: diagnosis.diagnosis,
    });

    // ── 3. ACT: remediate or escalate ─────────────────────────────────────
    logger.info("Step 3/4 — Executing action", {
      incidentId,
      action: diagnosis.action,
      confidence: diagnosis.confidence,
      threshold: CONFIDENCE_THRESHOLD,
    });

    let actionResult: string;
    let status: IncidentRecord["status"];

    const shouldAct = diagnosis.confidence >= CONFIDENCE_THRESHOLD &&
      diagnosis.action !== "escalate" &&
      diagnosis.action !== "no_action";

    if (!shouldAct) {
      // Escalate — confidence too low or action=escalate
      await escalate(ctx, diagnosis, incidentId);
      actionResult = `Escalated — confidence ${(diagnosis.confidence * 100).toFixed(0)}% below threshold ${(CONFIDENCE_THRESHOLD * 100).toFixed(0)}%`;
      status = "escalated";
    } else {
      try {
        actionResult = await executeAction(diagnosis, ctx);
        status = "remediated";
        logger.info("Remediation complete", { incidentId, actionResult });
      } catch (err) {
        actionResult = `Action failed: ${String(err)}`;
        status = "failed";
        logger.error("Remediation failed", { incidentId, err: String(err) });
        // Still escalate on failure
        await escalate(ctx, { ...diagnosis, escalation_message: actionResult }, incidentId);
      }
    }

    // ── 4. RECORD: generate post-mortem and save incident ─────────────────
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
      incidentId,
      status,
      durationMs: record.durationMs,
    });
  } catch (err) {
    logger.error("Unhandled error in ops loop", { incidentId, err: String(err) });
  } finally {
    inFlight.delete(fingerprint);
  }
}

async function executeAction(
  diagnosis: ReturnType<typeof Object.assign> & {
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
        throw new Error("Claude recommended rollback but provided no rollback_target image tag");
      }
      return await rollbackContainer(service, target);
    }

    case "scale_up": {
      const replicas = diagnosis.scale_replicas ?? 2;
      return await scaleUp(service, replicas);
    }

    case "reroute":
      // Reroute is service-specific — log intent and escalate for now
      return `Reroute requested for ${service} — ALB rule update required (manual or via IaC)`;

    case "no_action":
      return "No action taken — condition assessed as self-healing";

    default:
      throw new Error(`Unknown action: ${diagnosis.action}`);
  }
}
