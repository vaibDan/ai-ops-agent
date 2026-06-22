import { Router, Request, Response } from "express";
import { loadIncidents, getIncidentStats } from "../services/incidentLog.js";
import { listManagedDeployments } from "../services/kubernetes.js";

export const incidentsRouter = Router();

// GET /incidents — list recent incidents (newest first)
incidentsRouter.get("/", async (_req: Request, res: Response) => {
  const incidents = await loadIncidents(100);
  res.json({ count: incidents.length, incidents });
});

// GET /incidents/summary/stats — aggregated stats from Postgres
incidentsRouter.get("/summary/stats", async (_req: Request, res: Response) => {
  try {
    const stats = await getIncidentStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /incidents/:id — single incident
incidentsRouter.get("/:id", async (req: Request, res: Response) => {
  const incidents = await loadIncidents(500);
  const found = incidents.find((i) => i.id === req.params.id);
  if (!found) return res.status(404).json({ error: "Incident not found" });
  res.json(found);
});

// GET /containers — list managed deployments
incidentsRouter.get("/containers/list", async (_req: Request, res: Response) => {
  try {
    const containers = await listManagedDeployments();
    res.json({ containers });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});