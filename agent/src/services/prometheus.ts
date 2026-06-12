import { MetricsSnapshot } from "../types/index.js";
import { logger } from "../utils/logger.js";

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus:9090";

async function queryInstant(expr: string): Promise<number | null> {
  try {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(expr)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      status: string;
      data: { result: Array<{ value: [number, string] }> };
    };
    if (json.status !== "success" || json.data.result.length === 0) return null;
    return parseFloat(json.data.result[0].value[1]);
  } catch (err) {
    logger.warn("Prometheus query failed", { expr, err: String(err) });
    return null;
  }
}

export async function fetchMetricsSnapshot(): Promise<MetricsSnapshot> {
  const [errorRate, requestRate, p95Latency, cpuUsage, appUpRaw] =
    await Promise.all([
      queryInstant(
        `sum(rate(http_requests_total{status=~"5.."}[2m])) / sum(rate(http_requests_total[2m]))`
      ),
      queryInstant(`sum(rate(http_requests_total[2m]))`),
      queryInstant(
        `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))`
      ),
      queryInstant(`process_cpu_seconds_total{job="sample-app"}`),
      queryInstant(`up{job="sample-app"}`),
    ]);

  return {
    errorRate,
    requestRate,
    p95Latency,
    cpuUsage,
    appUp: appUpRaw === 1,
    queriedAt: new Date().toISOString(),
  };
}
