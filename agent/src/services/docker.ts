import Dockerode from "dockerode";
import { logger } from "../utils/logger.js";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

// ── Helpers ────────────────────────────────────────────────────────────────

function findContainer(service: string) {
  // Match by container name or ai-ops.service label
  return docker.listContainers({
    filters: JSON.stringify({
      label: [`ai-ops.service=${service}`],
    }),
  });
}

// ── Actions ────────────────────────────────────────────────────────────────

export async function restartContainer(service: string): Promise<string> {
  const containers = await findContainer(service);
  if (containers.length === 0) {
    throw new Error(`No managed container found for service: ${service}`);
  }

  const info = containers[0];
  const container = docker.getContainer(info.Id);
  logger.info(`Restarting container`, { id: info.Id.slice(0, 12), service });
  await container.restart({ t: 10 }); // 10s graceful stop
  return `Restarted container ${info.Names[0]} (${info.Id.slice(0, 12)})`;
}

export async function getContainerLogs(
  service: string,
  lines = 50
): Promise<string[]> {
  try {
    const containers = await findContainer(service);
    if (containers.length === 0) return [`[no container found for ${service}]`];

    const container = docker.getContainer(containers[0].Id);
    const logsBuffer = await container.logs({
      stdout: true,
      stderr: true,
      tail: lines,
      timestamps: true,
    });

    // Docker multiplexes stdout/stderr — strip the 8-byte header from each frame
    const raw = logsBuffer.toString("utf8");
    return raw
      .split("\n")
      .map((line) => line.replace(/^[\x00-\x08].{7}/, "").trim())
      .filter(Boolean)
      .slice(-lines);
  } catch (err) {
    logger.warn("Failed to fetch container logs", { service, err: String(err) });
    return [`[log fetch failed: ${String(err)}]`];
  }
}

export async function rollbackContainer(
  service: string,
  imageTag: string
): Promise<string> {
  const containers = await findContainer(service);
  if (containers.length === 0) {
    throw new Error(`No managed container found for service: ${service}`);
  }

  const info = containers[0];
  const container = docker.getContainer(info.Id);

  // Pull the target image
  logger.info(`Pulling rollback image`, { service, imageTag });
  await new Promise<void>((resolve, reject) => {
    docker.pull(imageTag, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2: Error | null) =>
        err2 ? reject(err2) : resolve()
      );
    });
  });

  // Stop and remove current container
  await container.stop({ t: 10 });
  await container.remove();

  // Create new container from rolled-back image with same config
  const newContainer = await docker.createContainer({
    Image: imageTag,
    name: info.Names[0].replace("/", ""),
    Labels: info.Labels,
    ExposedPorts: info.Ports.reduce(
      (acc, p) => ({ ...acc, [`${p.PrivatePort}/tcp`]: {} }),
      {}
    ),
  });
  await newContainer.start();

  return `Rolled back ${service} to ${imageTag} — new container ${newContainer.id.slice(0, 12)}`;
}

export async function scaleUp(
  service: string,
  targetReplicas: number
): Promise<string> {
  // On plain Docker Compose (no Swarm), "scaling" means spawning additional containers.
  // We inspect the existing container's config and clone it with a numeric suffix.
  const containers = await findContainer(service);
  if (containers.length === 0) {
    throw new Error(`No managed container found for service: ${service}`);
  }

  const existing = containers[0];
  const needed = targetReplicas - containers.length;

  if (needed <= 0) {
    return `Already at ${containers.length} replica(s) — no scale needed`;
  }

  const baseContainer = docker.getContainer(existing.Id);
  const inspect = await baseContainer.inspect();

  const spawned: string[] = [];
  for (let i = 1; i <= needed; i++) {
    const name = `${service}-replica-${Date.now()}-${i}`;
    const newContainer = await docker.createContainer({
      Image: inspect.Config.Image,
      name,
      Env: inspect.Config.Env || [],
      Labels: { ...inspect.Config.Labels, "ai-ops.managed": "true" },
      HostConfig: inspect.HostConfig,
    });
    await newContainer.start();
    spawned.push(newContainer.id.slice(0, 12));
    logger.info(`Spawned replica`, { name, id: newContainer.id.slice(0, 12) });
  }

  return `Scaled ${service} to ${targetReplicas} replicas — new containers: ${spawned.join(", ")}`;
}

export async function listManagedContainers(): Promise<
  Array<{ name: string; status: string; image: string }>
> {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: ["ai-ops.managed=true"] }),
  });
  return containers.map((c) => ({
    name: c.Names[0],
    status: c.Status,
    image: c.Image,
  }));
}
