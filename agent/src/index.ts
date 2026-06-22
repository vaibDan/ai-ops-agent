import express from "express";
import { alertRouter } from "./routes/webhook.js";
import { incidentsRouter } from "./route/incidents.js";
import { logger } from "./utils/logger.js";
import { register } from "prom-client";

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Prometheus metrics for the agent itself
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use("/webhook", alertRouter);
app.use("/incidents", incidentsRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error("Unhandled Express error", { err: err.message });
  res.status(500).json({ error: "Internal server error" });
});

// ── Boot ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`AI Ops Agent listening on port ${PORT}`);
  logger.info(`Confidence threshold: ${process.env.CONFIDENCE_THRESHOLD || "0.8"}`);
  logger.info(`Prometheus URL: ${process.env.PROMETHEUS_URL || "http://prometheus:9090"}`);

  if (!process.env.GOOGLE_API_KEY) {
    logger.error("GOOGLE_API_KEY is not set — Google calls will fail");
  }
});


// ── Graceful shutdown ──────────────────────────────────────────────────────
import { closePool } from "./services/incidentLog.js";

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received — closing Postgres pool");
  await closePool();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received — closing Postgres pool");
  await closePool();
  process.exit(0);
});