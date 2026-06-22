import { MetricsSnapshot } from "../types/index.js";
import { logger } from "../utils/logger.js";

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const NAMESPACE = process.env.NAMESPACE || "ai-ops";

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
  const [errorRate, requestRate, p95Latency, cpuUsage, appUpRaw, restartCount] =
    await Promise.all([
      queryInstant(
        `sum(rate(http_requests_total{status=~"5..",namespace="${NAMESPACE}"}[2m]))
        / sum(rate(http_requests_total{namespace="${NAMESPACE}"}[2m]))`
      ),
      queryInstant(
        `sum(rate(http_requests_total{namespace="${NAMESPACE}"}[2m]))`
      ),
      queryInstant(
        `histogram_quantile(0.95,
          sum(rate(http_request_duration_seconds_bucket{namespace="${NAMESPACE}"}[5m])) by (le)
        )`
      ),
      queryInstant(
        `process_cpu_seconds_total{job="sample-app"}`
      ),
      queryInstant(
        `up{namespace="${NAMESPACE}",pod=~"sample-app.*"}`
      ),
      // Total restarts across all sample-app containers — sourced from
      // kube-state-metrics which kube-prometheus-stack installs by default.
      queryInstant(
        `sum(kube_pod_container_status_restarts_total{namespace="${NAMESPACE}",pod=~"sample-app.*"})`
      ),
    ]);

  return {
    errorRate,
    requestRate,
    p95Latency,
    cpuUsage,
    appUp: appUpRaw === 1,
    restartCount,
    queriedAt: new Date().toISOString(),
  };
}