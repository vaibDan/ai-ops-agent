import { Router, Request, Response } from "express";
import { loadIncidents } from "../services/incidentLog.js";
import { listManagedContainers } from "../services/docker.js";

export const incidentsRouter = Router();

// GET /incidents — list all incidents (newest first)
incidentsRouter.get("/", (_req: Request, res: Response) => {
  const incidents = loadIncidents().reverse();
  res.json({ count: incidents.length, incidents });
});

// GET /incidents/:id — single incident with full post-mortem
incidentsRouter.get("/:id", (req: Request, res: Response) => {
  const incidents = loadIncidents();
  const found = incidents.find((i) => i.id === req.params.id);
  if (!found) return res.status(404).json({ error: "Incident not found" });
  res.json(found);
});

// GET /incidents/summary/stats — quick stats for dashboards
incidentsRouter.get("/summary/stats", (_req: Request, res: Response) => {
  const incidents = loadIncidents();
  const counts = incidents.reduce(
    (acc, i) => {
      acc[i.status] = (acc[i.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  const avgDuration =
    incidents.length > 0
      ? Math.round(incidents.reduce((s, i) => s + i.durationMs, 0) / incidents.length)
      : 0;

  res.json({
    total: incidents.length,
    byStatus: counts,
    avgDurationMs: avgDuration,
    lastIncident: incidents[incidents.length - 1]?.timestamp ?? null,
  });
});

// GET /containers — list managed containers
incidentsRouter.get("/containers/list", async (_req: Request, res: Response) => {
  try {
    const containers = await listManagedContainers();
    res.json({ containers });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
