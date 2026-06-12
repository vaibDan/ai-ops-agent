import { Router, Request, Response } from "express";
import { AlertmanagerPayload } from "../types/index.js";
import { handleAlertPayload } from "../services/opsLoop.js";
import { logger } from "../utils/logger.js";

export const alertRouter = Router();

// POST /webhook/alert — receives Alertmanager webhook
alertRouter.post("/alert", async (req: Request, res: Response) => {
  const payload = req.body as AlertmanagerPayload;

  if (!payload || !Array.isArray(payload.alerts)) {
    logger.warn("Invalid webhook payload", { body: req.body });
    return res.status(400).json({ error: "Invalid payload — expected Alertmanager format" });
  }

  logger.info("Webhook received", {
    status: payload.status,
    alertCount: payload.alerts.length,
    groupKey: payload.groupKey,
  });

  // Acknowledge immediately — Alertmanager expects a fast response
  res.status(200).json({ received: true, alertCount: payload.alerts.length });

  // Process asynchronously so we don't block the webhook ack
  handleAlertPayload(payload).catch((err) => {
    logger.error("handleAlertPayload threw", { err: String(err) });
  });
});
