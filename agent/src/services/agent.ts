import { GoogleGenAI } from "@google/genai";
import { ClaudeDiagnosis, OpsContext } from "../types/index.js";
import { logger } from "../utils/logger.js";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ── System prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert SRE (Site Reliability Engineer) and autonomous ops agent.
You receive real-time observability data (metrics, logs, alerts) and must diagnose the root cause of incidents and decide on a remediation action.

DECISION FRAMEWORK:
1. Analyze the alert type, severity, and action_hint label
2. Cross-reference with current metrics (error rate, latency, CPU, uptime)
3. Scan recent logs for stack traces, OOM kills, crash loops, or deployment errors
4. Choose the most conservative effective action
5. Assign confidence based on signal clarity

AVAILABLE ACTIONS:
- restart_container: For crash loops, OOM kills, frozen processes. Fast recovery.
- scale_up: For traffic spikes causing CPU/latency pressure with no errors in logs.
- rollback: For error spikes immediately following a deployment (look for deploy logs).
- reroute: For partial failures — shift traffic away from unhealthy instances.
- escalate: For novel failures, data corruption risk, or security incidents. Always escalate when confidence < 0.8.
- no_action: For self-healing conditions or already-resolved alerts.

CONFIDENCE GUIDELINES:
- 0.9+: Clear signal, single root cause, known pattern
- 0.8–0.9: Probable cause, minor ambiguity
- 0.6–0.8: Multiple possible causes — ESCALATE
- <0.6: Insufficient signal — ESCALATE

RESPONSE FORMAT:
You MUST respond with ONLY a valid JSON object. No markdown, no explanation outside the JSON.
Schema:
{
  "diagnosis": "<concise root cause explanation, 1-2 sentences>",
  "action": "<one of: restart_container | scale_up | rollback | reroute | escalate | no_action>",
  "confidence": <float 0.0–1.0>,
  "reasoning": "<step-by-step chain of thought, 3-5 sentences>",
  "rollback_target": "<image:tag if action=rollback, else omit>",
  "scale_replicas": <integer if action=scale_up, else omit>,
  "escalation_message": "<human-readable message if action=escalate, else omit>"
}`;

// ── Context window builder ─────────────────────────────────────────────────
function buildUserPrompt(ctx: OpsContext): string {
  const m = ctx.metrics;
  const metricsBlock = `
CURRENT METRICS (as of ${m.queriedAt}):
- App up: ${m.appUp}
- Error rate: ${m.errorRate !== null ? (m.errorRate * 100).toFixed(2) + "%" : "unknown"}
- Request rate: ${m.requestRate !== null ? m.requestRate.toFixed(3) + " req/s" : "unknown"}
- p95 latency: ${m.p95Latency !== null ? m.p95Latency.toFixed(3) + "s" : "unknown"}
- CPU usage: ${m.cpuUsage !== null ? m.cpuUsage.toFixed(3) + "s (cumulative)" : "unknown"}`.trim();

  const alertBlock = `
ALERT:
- Name: ${ctx.alert.name}
- Severity: ${ctx.alert.severity}
- Service: ${ctx.alert.service}
- Summary: ${ctx.alert.summary}
- Description: ${ctx.alert.description}
- Action hint: ${ctx.alert.actionHint}
- Fired at: ${ctx.alert.firedAt}`.trim();

  const logsBlock =
    ctx.recentLogs.length > 0
      ? `RECENT LOGS (last ${ctx.recentLogs.length} lines):\n${ctx.recentLogs.join("\n")}`
      : "RECENT LOGS: unavailable";

  return [alertBlock, metricsBlock, logsBlock].join("\n\n");
}

// ── Shared: call Gemini and return raw text ────────────────────────────────
async function callGemini(systemInstruction: string, userPrompt: string): Promise<string> {
  const response = await ai.models.generateContent({
    model: MODEL,
    config: { systemInstruction },
    contents: userPrompt,
  });

  const text = response.text ?? "";
  // Strip accidental markdown fences Gemini sometimes adds
  return text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

// ── Main diagnosis call ────────────────────────────────────────────────────
export async function diagnose(ctx: OpsContext): Promise<ClaudeDiagnosis> {
  const userPrompt = buildUserPrompt(ctx);
  logger.debug("Calling Gemini API", { model: MODEL, alertName: ctx.alert.name });

  let raw = "";
  try {
    raw = await callGemini(SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    logger.error("Gemini API call failed", { err: String(err) });
    return {
      diagnosis: "Gemini API call failed — escalating for human review",
      action: "escalate",
      confidence: 0,
      reasoning: `API error: ${String(err)}`,
      escalation_message: "AI Ops Agent failed to reach Gemini API. Manual investigation required.",
    };
  }

  logger.debug("Raw Gemini response", { raw });

  let parsed: ClaudeDiagnosis;
  try {
    parsed = JSON.parse(raw) as ClaudeDiagnosis;
  } catch (err) {
    logger.error("Failed to parse Gemini response as JSON", { raw, err: String(err) });
    return {
      diagnosis: "Gemini returned unparseable response — escalating for human review",
      action: "escalate",
      confidence: 0,
      reasoning: `Parse error: ${String(err)}. Raw response: ${raw.slice(0, 200)}`,
      escalation_message: "AI Ops Agent failed to parse LLM response. Manual investigation required.",
    };
  }

  // Validate action field
  const validActions = [
    "restart_container",
    "scale_up",
    "rollback",
    "reroute",
    "escalate",
    "no_action",
  ];
  if (!validActions.includes(parsed.action)) {
    logger.warn("Gemini returned invalid action, defaulting to escalate", {
      action: parsed.action,
    });
    parsed.action = "escalate";
    parsed.confidence = Math.min(parsed.confidence, 0.5);
  }

  return parsed;
}

// ── Post-mortem generator ──────────────────────────────────────────────────
export async function generatePostMortem(
  ctx: OpsContext,
  diagnosis: ClaudeDiagnosis,
  actionResult: string
): Promise<string> {
  const prompt = `Generate a concise incident post-mortem in plain text (no markdown headers).

Alert: ${ctx.alert.name} on ${ctx.alert.service}
Fired at: ${ctx.alert.firedAt}
Diagnosis: ${diagnosis.diagnosis}
Action taken: ${actionResult}
Confidence: ${diagnosis.confidence}

Include: (1) what happened, (2) root cause, (3) action taken and outcome, (4) one preventive recommendation. Keep it under 150 words.`;

  try {
    return await callGemini("You are an SRE writing a post-mortem report.", prompt);
  } catch (err) {
    logger.error("Post-mortem generation failed", { err: String(err) });
    return `Post-mortem generation failed: ${String(err)}`;
  }
}