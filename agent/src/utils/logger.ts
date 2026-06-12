const level = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[level] ?? 1;

function fmt(lvl: string, msg: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  return `${ts} [${lvl.toUpperCase().padEnd(5)}] ${msg}${metaStr}`;
}

export const logger = {
  debug: (msg: string, meta?: unknown) => {
    if (currentLevel <= 0) console.debug(fmt("debug", msg, meta));
  },
  info: (msg: string, meta?: unknown) => {
    if (currentLevel <= 1) console.info(fmt("info", msg, meta));
  },
  warn: (msg: string, meta?: unknown) => {
    if (currentLevel <= 2) console.warn(fmt("warn", msg, meta));
  },
  error: (msg: string, meta?: unknown) => {
    if (currentLevel <= 3) console.error(fmt("error", msg, meta));
  },
};
