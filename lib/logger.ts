/**
 * Tiny structured logger. Writes to stdout/stderr so Render captures it in the
 * service logs. Each line: [ISO timestamp] [LEVEL] message {optional meta}.
 */

type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, meta?: unknown): void {
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  const sink =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;

  if (meta === undefined) {
    sink(`${prefix} ${message}`);
  } else if (meta instanceof Error) {
    sink(`${prefix} ${message}`, meta.stack || meta.message);
  } else if (typeof meta === "object") {
    try {
      sink(`${prefix} ${message}`, JSON.stringify(meta));
    } catch {
      sink(`${prefix} ${message}`, meta);
    }
  } else {
    sink(`${prefix} ${message}`, meta);
  }
}

export const logger = {
  info: (message: string, meta?: unknown) => emit("info", message, meta),
  warn: (message: string, meta?: unknown) => emit("warn", message, meta),
  error: (message: string, meta?: unknown) => emit("error", message, meta),
};
