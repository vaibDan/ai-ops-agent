import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { IncidentRecord } from "../types/index.js";
import { logger } from "../utils/logger.js";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const LOG_FILE = join(DATA_DIR, "incidents.json");

function ensureDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function saveIncident(record: IncidentRecord): void {
  try {
    ensureDir();
    // Append JSON-lines format — one record per line, easy to tail/stream
    appendFileSync(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
    logger.info("Incident saved", { id: record.id, status: record.status });
  } catch (err) {
    logger.error("Failed to save incident", { err: String(err) });
  }
}

export function loadIncidents(): IncidentRecord[] {
  try {
    ensureDir();
    if (!existsSync(LOG_FILE)) return [];
    return readFileSync(LOG_FILE, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as IncidentRecord);
  } catch (err) {
    logger.error("Failed to load incidents", { err: String(err) });
    return [];
  }
}

export function generateIncidentId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `INC-${ts}-${rand}`;
}
