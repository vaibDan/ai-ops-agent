import { GoogleGenAI } from "@google/genai";
import { ClaudeDiagnosis, OpsContext } from "../types/index.js";
import { logger } from "../utils/logger.js";

// ── Primary: Gemini ────────────────────────────────────────────────────────
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ── Fallback: OpenRouter ───────────────────────────────────────────────────
// OpenRouter exposes an OpenAI-compatible REST API, so no extra SDK needed.
// Free models: mistralai/mistral-7b-instruct:free
//              meta-llama/llama-3.1-8b-instruct:free
//              google/gemma-2-9b-it:free
// Get a free key at: https://openrouter.ai/keys
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL
  || "meta-llama/llama-3.1-8b-instruct:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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

  const alertBlock = `
ALERT:
- Name: ${ctx.alert.name}
- Severity: ${ctx.alert.severity}
- Service: ${ctx.alert.service}
- Summary: ${ctx.alert.summary}
- Description: ${ctx.alert.description}
- Action hint: ${ctx.alert.actionHint}
- Fired at: ${ctx.alert.firedAt}`.trim();

  const metricsBlock = `
CURRENT METRICS (as of ${m.queriedAt}):
- App up: ${m.appUp}
- Error rate: ${m.errorRate !== null ? (m.errorRate * 100).toFixed(2) + "%" : "unknown"}
- Request rate: ${m.requestRate !== null ? m.requestRate.toFixed(3) + " req/s" : "unknown"}
- p95 latency: ${m.p95Latency !== null ? m.p95Latency.toFixed(3) + "s" : "unknown"}
- CPU usage: ${m.cpuUsage !== null ? m.cpuUsage.toFixed(3) + "s (cumulative)" : "unknown"}
- Restart count: ${m.restartCount !== null ? m.restartCount : "unknown"}`.trim();

  const logsBlock = ctx.recentLogs.length > 0
    ? `RECENT LOGS (last ${ctx.recentLogs.length} lines):\n${ctx.recentLogs.join("\n")}`
    : "RECENT LOGS: unavailable";

  return [alertBlock, metricsBlock, logsBlock].join("\n\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanJson(raw: string): string {
  return raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

function isRateLimitError(err: unknown): boolean {
  const s = String(err).toLowerCase();
  return s.includes("429") || s.includes("resource_exhausted") ||
    s.includes("too many requests") || s.includes("quota");
}

function parseRetryDelay(err: unknown): number {
  const match = String(err).match(/retry[^":\d]*[":\s]+(\d+(?:\.\d+)?)\s*s/i);
  if (match) {
    const secs = parseFloat(match[1]);
    logger.info(`Gemini retry delay from response: ${secs}s`);
    return Math.ceil(secs * 1000) + 1000;
  }
  return 35_000;
}

// ── Gemini rate limiter ────────────────────────────────────────────────────
// Serializes all Gemini calls and enforces spacing to respect the 5 RPM
// free tier limit. On 429, reads Gemini's retryDelay and blocks the whole
// queue until the window passes, then retries.
const MIN_INTERVAL_MS = parseInt(process.env.GEMINI_MIN_INTERVAL_MS || "6000", 10);
const MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || "3", 10);

let geminiQueue: Promise<void> = Promise.resolve();
let lastGeminiAt: number = 0;
let geminiBlocked: number = 0;

async function withGeminiRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = geminiQueue;
  geminiQueue = new Promise<void>((res) => { release = res; });
  await prev;

  try {
    const blockWait = geminiBlocked - Date.now();
    if (blockWait > 0) {
      logger.info(`Gemini cooldown — waiting ${Math.ceil(blockWait / 1000)}s`);
      await sleep(blockWait);
    }

    const elapsed = Date.now() - lastGeminiAt;
    if (lastGeminiAt > 0 && elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await fn();
        lastGeminiAt = Date.now();
        return result;
      } catch (err) {
        if (isRateLimitError(err) && attempt < MAX_RETRIES) {
          const waitMs = parseRetryDelay(err);
          geminiBlocked = Date.now() + waitMs;
          logger.warn("Gemini 429 — blocking queue", {
            attempt: attempt + 1,
            waitSecs: Math.ceil(waitMs / 1000),
            unblockAt: new Date(geminiBlocked).toISOString(),
          });
          await sleep(waitMs);
        } else {
          lastGeminiAt = Date.now();
          throw err;   // exhausted retries → caller catches and tries fallback
        }
      }
    }
  } finally {
    release();
  }
}

// ── Provider calls ─────────────────────────────────────────────────────────

async function callGemini(
  systemInstruction: string,
  userPrompt: string
): Promise<string> {
  return withGeminiRateLimit(async () => {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      config: { systemInstruction },
      contents: userPrompt,
    });
    return cleanJson(response.text ?? "");
  });
}

// OpenRouter: OpenAI-compatible chat completions endpoint.
// No SDK needed — plain fetch with Bearer token.
async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set — cannot use fallback LLM. " +
      "Get a free key at https://openrouter.ai/keys"
    );
  }

  logger.info("Using OpenRouter fallback", { model: OPENROUTER_MODEL });

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      // OpenRouter uses these headers to identify your app in their dashboard
      "HTTP-Referer": "https://github.com/ai-ops-agent",
      "X-Title": "AI Ops Agent",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      // Ask for JSON output — most modern models respect this
      response_format: { type: "json_object" },
      temperature: 0.1,   // low temp for deterministic SRE decisions
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    error?: { message: string };
  };

  if (json.error) throw new Error(`OpenRouter error: ${json.error.message}`);

  const content = json.choices?.[0]?.message?.content ?? "";
  return cleanJson(content);
}

// ── Primary → fallback orchestration ──────────────────────────────────────
// Try Gemini first. If it fails for any reason (quota, network, timeout),
// immediately try OpenRouter. If both fail, throw so the caller can
// return a safe escalation response.
async function callLLM(
  systemPrompt: string,
  userPrompt: string
): Promise<{ raw: string; provider: string }> {
// ── Try Gemini ────────────────────────────────────────────────────────
  try {
    const raw = await callGemini(systemPrompt, userPrompt);
    return { raw, provider: "gemini" };
  } catch (geminiErr) {
    logger.warn("Gemini failed — trying OpenRouter fallback", {
      reason: String(geminiErr).slice(0, 150),
      fallbackModel: OPENROUTER_MODEL,
    });
  }

  // ── Try OpenRouter ────────────────────────────────────────────────────
  try {
    const raw = await callOpenRouter(systemPrompt, userPrompt);
    return { raw, provider: "openrouter" };
  } catch (orErr) {
    throw new Error(
      `Both providers failed. ` +
      `OpenRouter error: ${String(orErr).slice(0, 200)}`
    );
  }
}

// ── JSON parse + validate ──────────────────────────────────────────────────
function parseAndValidate(raw: string, provider: string): ClaudeDiagnosis {
  let parsed: ClaudeDiagnosis;
  try {
    parsed = JSON.parse(raw) as ClaudeDiagnosis;
  } catch (err) {
    throw new Error(
      `[${provider}] JSON parse failed: ${String(err)}. Raw: ${raw.slice(0, 200)}`
    );
  }

  const validActions = [
    "restart_container", "scale_up", "rollback",
    "reroute", "escalate", "no_action",
  ];
  if (!validActions.includes(parsed.action)) {
    logger.warn(`[${provider}] Invalid action — defaulting to escalate`, {
      action: parsed.action,
    });
    parsed.action = "escalate";
    parsed.confidence = Math.min(parsed.confidence ?? 0, 0.5);
  }

  return parsed;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function diagnose(ctx: OpsContext): Promise<ClaudeDiagnosis> {
  const userPrompt = buildUserPrompt(ctx);
  logger.debug("Starting diagnosis", { alert: ctx.alert.name });

  try {
    const { raw, provider } = await callLLM(SYSTEM_PROMPT, userPrompt);
    logger.debug("Raw LLM response", { provider, raw });
    const result = parseAndValidate(raw, provider);
    logger.info("Diagnosis complete", {
      provider,
      action: result.action,
      confidence: result.confidence,
    });
    return result;
  } catch (err) {
    logger.error("All LLM providers failed — escalating", { err: String(err) });
    return {
      diagnosis: "All LLM providers failed — escalating for human review",
      action: "escalate",
      confidence: 0,
      reasoning: String(err),
      escalation_message: "AI Ops Agent: both Gemini and OpenRouter failed. Manual review required.",
    };
  }
}

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
    const { raw } = await callLLM(
      "You are an SRE writing a post-mortem report.",
      prompt
    );
    return raw;
  } catch (err) {
    logger.error("Post-mortem generation failed on all providers", { err: String(err) });
    return [
      `Incident: ${ctx.alert.name} on ${ctx.alert.service}`,
      `Fired at: ${ctx.alert.firedAt}`,
      `Diagnosis: ${diagnosis.diagnosis}`,
      `Action: ${actionResult}`,
      `Note: Post-mortem generation failed (${String(err).slice(0, 120)}). Review manually.`,
    ].join("\n");
  }
}