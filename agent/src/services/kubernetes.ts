import * as k8s from "@kubernetes/client-node";
import { logger } from "../utils/logger.js";

const kc = new k8s.KubeConfig();

if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
} else {
    kc.loadFromDefault();
}

const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

const NAMESPACE = process.env.NAMESPACE || "ai-ops";

// ── Rolling restart (equivalent to: kubectl rollout restart deployment/<name>) ──
export async function restartDeployment(
    service: string
): Promise<string> {

    await appsV1.patchNamespacedDeployment({
        name: service,
        namespace: NAMESPACE,
        body: [
            {
                op: "add",
                path: "/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt",
                value: new Date().toISOString(),
            },
        ],
    });

    logger.info("Rolling restart triggered", {
        service,
        NAMESPACE,
    });

    return `Rolling restart triggered for deployment/${service} in ${NAMESPACE}`;
}


// ── Scale replicas ────────────────────────────────────────────────────────────
export async function scaleDeployment(
    service: string,
    replicas: number
): Promise<string> {
    await appsV1.patchNamespacedDeployment({
        name: service,
        namespace: NAMESPACE,
        body: [
            {
                op: "replace",
                path: "/spec/replicas",
                value: replicas,
            },
        ],
    });

    logger.info("Deployment scaled", { service, replicas, NAMESPACE });
    return `Scaled deployment/${service} to ${replicas} replicas in ${NAMESPACE}`;
}

// ── Rollback to a specific image tag ─────────────────────────────────────────
export async function rollbackDeployment(
    service: string,
    imageTag: string
): Promise<string> {
    await appsV1.patchNamespacedDeployment({
        name: service,
        namespace: NAMESPACE,
        body: [
            {
                op: "replace",
                path: "/spec/template/spec/containers/0/image",
                value: imageTag,
            },
        ],
    });

    logger.info("Deployment rolled back", { service, imageTag });
    return `Rolled back deployment/${service} to image ${imageTag}`;
}

// ── Fetch pod logs for a deployment ──────────────────────────────────────────
export async function getPodLogs(
    service: string,
    lines = 50
): Promise<string[]> {
    try {
        const podList = await coreV1.listNamespacedPod({
            namespace: NAMESPACE,
            labelSelector: `app=${service}`,
        });

        const pods = podList.items;
        if (pods.length === 0) {
            return [`[no pods found for app=${service} in ${NAMESPACE}]`];
        }

        const pod =
            pods.find((p) => p.status?.phase === "Running") ?? pods[0];
        const podName = pod.metadata?.name ?? "";
        const containerName = pod.spec?.containers[0]?.name ?? service;

        const logResponse = await coreV1.readNamespacedPodLog({
            name: podName,
            namespace: NAMESPACE,
            container: containerName,
            tailLines: lines,
        });

        return String(logResponse)
            .split("\n")
            .filter(Boolean)
            .slice(-lines);
    } catch (err) {
        logger.warn("Failed to fetch pod logs", { service, err: String(err) });
        return [`[log fetch failed: ${String(err)}]`];
    }
}

// ── List all deployments in the namespace ─────────────────────────────────────
export async function listManagedDeployments(): Promise<
    Array<{ name: string; replicas: number; ready: number; image: string }>
> {
    const list = await appsV1.listNamespacedDeployment({ namespace: NAMESPACE });
    return list.items.map((d) => ({
        name: d.metadata?.name ?? "",
        replicas: d.spec?.replicas ?? 0,
        ready: d.status?.readyReplicas ?? 0,
        image: d.spec?.template.spec?.containers[0]?.image ?? "",
    }));
}

// ── Aliases so opsLoop.ts import line stays the same ──────────────────────────
export const restartContainer = restartDeployment;
export const getContainerLogs = getPodLogs;
export const scaleUp = (service: string, replicas: number) =>
    scaleDeployment(service, replicas);


// / ── Pod restart info — used for PodCrashLooping diagnosis ─────────────────
// Returns per-pod restart counts and last termination reason/message.
// This is the critical context Gemini needs to distinguish:
//   OOMKilled    → scale up memory or fix leak
//   Error (exit 1) → bad config, missing env var, or bad image
//   StartError   → image pull failed or entrypoint not found
export interface PodRestartInfo {
    podName: string;
    restartCount: number;
    lastState: string;       // OOMKilled | Error | Completed | StartError
    lastExitCode: number;
    lastReason: string;
    lastMessage: string;
}

export async function getPodRestartInfo(
    service: string
): Promise<PodRestartInfo[]> {
    try {
        const podList = await coreV1.listNamespacedPod({
            namespace: NAMESPACE,
            labelSelector: `app=${service}`,
        });

        return podList.items.map((pod: k8s.V1Pod) => {
            const cs = pod.status?.containerStatuses?.[0];
            const last = cs?.lastState?.terminated;
            return {
                podName: pod.metadata?.name ?? "unknown",
                restartCount: cs?.restartCount ?? 0,
                lastState: last?.reason ?? "Unknown",
                lastExitCode: last?.exitCode ?? -1,
                lastReason: last?.reason ?? "Unknown",
                lastMessage: last?.message ?? "",
            };
        });
    } catch (err) {
        logger.warn("Failed to fetch pod restart info", { service, err: String(err) });
        return [];
    }
}