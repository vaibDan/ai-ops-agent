import express from "express";
import { Registry, Counter, Histogram, Gauge } from "prom-client";

const app = express();
const port = process.env.PORT || 3001;

// ── Prometheus registry ────────────────────────────────────────────────────
const register = new Registry();

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

// Manual spike trigger gauge — set to 1 to fire the ErrorSpike alert
const errorSpikeGauge = new Gauge({
  name: "app_error_spike",
  help: "Set to 1 to trigger ErrorSpike alert (test only)",
  registers: [register],
});

errorSpikeGauge.set(0);

// ── State ──────────────────────────────────────────────────────────────────
let spikeMode = false;
let spikeTimeout: NodeJS.Timeout | null = null;

// ── Middleware ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path;
    httpRequestsTotal.labels(req.method, route, String(res.statusCode)).inc();
    httpRequestDuration
      .labels(req.method, route, String(res.statusCode))
      .observe(duration);
  });
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  if (spikeMode && Math.random() < 0.7) {
    return res.status(500).json({ error: "Internal Server Error (simulated)" });
  }
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/health", (_req, res) => {
  res.json({ status: "healthy" });
});

// Expose Prometheus metrics
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// ── Spike simulation endpoints ─────────────────────────────────────────────
app.post("/spike/start", (_req, res) => {
  spikeMode = true;
  errorSpikeGauge.set(1);
  console.log("[sample-app] ERROR SPIKE STARTED");

  // Auto-clear after 5 minutes to avoid infinite alert
  if (spikeTimeout) clearTimeout(spikeTimeout);
  spikeTimeout = setTimeout(() => {
    spikeMode = false;
    errorSpikeGauge.set(0);
    console.log("[sample-app] Error spike auto-cleared after 5 minutes");
  }, 5 * 60 * 1000);

  res.json({ status: "spike_started", message: "70% of requests will 500" });
});

app.post("/spike/stop", (_req, res) => {
  spikeMode = false;
  errorSpikeGauge.set(0);
  if (spikeTimeout) {
    clearTimeout(spikeTimeout);
    spikeTimeout = null;
  }
  console.log("[sample-app] Error spike stopped");
  res.json({ status: "spike_stopped" });
});

app.get("/spike/status", (_req, res) => {
  res.json({ spikeMode });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`[sample-app] Running on port ${port}`);
});
