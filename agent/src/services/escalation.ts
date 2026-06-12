import { ClaudeDiagnosis, OpsContext } from "../types/index.js";
import { logger } from "../utils/logger.js";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
}

export async function escalate(
  ctx: OpsContext,
  diagnosis: ClaudeDiagnosis,
  incidentId: string
): Promise<void> {
  const message = diagnosis.escalation_message ||
    `${ctx.alert.name} on ${ctx.alert.service} — confidence ${(diagnosis.confidence * 100).toFixed(0)}% — requires human review`;

  logger.warn("ESCALATION REQUIRED", {
    incidentId,
    alert: ctx.alert.name,
    service: ctx.alert.service,
    diagnosis: diagnosis.diagnosis,
    confidence: diagnosis.confidence,
    message,
  });

  if (!SLACK_WEBHOOK_URL) {
    logger.info("No SLACK_WEBHOOK_URL set — escalation logged only");
    return;
  }

  const severity = ctx.alert.severity === "critical" ? "🔴" : "🟡";
  const confidencePct = (diagnosis.confidence * 100).toFixed(0);

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${severity} AI Ops Escalation — ${ctx.alert.name}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Incident ID:*\n${incidentId}` },
        { type: "mrkdwn", text: `*Service:*\n${ctx.alert.service}` },
        { type: "mrkdwn", text: `*Severity:*\n${ctx.alert.severity}` },
        { type: "mrkdwn", text: `*AI Confidence:*\n${confidencePct}%` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Diagnosis:*\n${diagnosis.diagnosis}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Reasoning:*\n${diagnosis.reasoning}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Action Required:*\n${message}`,
      },
    },
  ];

  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.error("Slack webhook failed", { status: res.status });
    } else {
      logger.info("Slack escalation sent", { incidentId });
    }
  } catch (err) {
    logger.error("Slack webhook error", { err: String(err) });
  }
}
