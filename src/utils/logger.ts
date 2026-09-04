import util from "util";

type LogLevel = "info" | "warn" | "error";
type LogMeta = Record<string, unknown>;

const SENSITIVE_KEYS = new Set([
  "authorization",
  "accessToken",
  "refreshToken",
  "token",
  "clientSecret",
  "client_secret",
  "apiKey",
  "api_key",
  "secret",
  "password",
  "cookie",
  "set-cookie",
  "verificationToken",
  "verification_token",
  "resetToken",
  "reset_token",
]);

const redactString = (value: string): string => {
  let result = value;

  // Authorization headers / Bearer tokens
  result = result.replace(
    /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    "Bearer [REDACTED]"
  );

  // Sensitive query-string parameters
  result = result.replace(
    /([?&](?:token|access_token|refresh_token|api_key|key|secret)=)[^&\s]+/gi,
    "$1[REDACTED]"
  );

  // Email addresses
  result = result.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[REDACTED_EMAIL]"
  );

  // Phone numbers
  result = result.replace(
    /(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)/g,
    "[REDACTED_PHONE]"
  );

  return result;
};

const sanitize = (
  value: unknown,
  seen = new WeakSet<object>()
): unknown => {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(process.env.NODE_ENV !== "production" && value.stack
        ? {
            stack: redactString(value.stack),
          }
        : {}),
    };
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value as object)) {
    return "[Circular]";
  }

  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen));
  }

  const output: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (
      SENSITIVE_KEYS.has(key) ||
      SENSITIVE_KEYS.has(key.toLowerCase())
    ) {
      output[key] = "[REDACTED]";
      continue;
    }

    output[key] = sanitize(nestedValue, seen);
  }

  return output;
};

const write = (
  level: LogLevel,
  message: string,
  meta?: unknown
): void => {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message: redactString(message),
    ...(meta !== undefined
      ? {
          meta: sanitize(meta),
        }
      : {}),
  };

  const line = JSON.stringify(record);

  if (level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
};

export const logger = {
  info(message: string, meta?: unknown): void {
    write("info", message, meta);
  },

  warn(message: string, meta?: unknown): void {
    write("warn", message, meta);
  },

  error(
    message: string,
    error?: unknown,
    meta?: LogMeta
  ): void {
    const combined = {
      ...(meta ?? {}),
      ...(error !== undefined
        ? {
            error: sanitize(error),
          }
        : {}),
    };

    write("error", message, combined);
  },

  debug(message: string, meta?: unknown): void {
    if (process.env.NODE_ENV !== "production") {
      write("info", message, meta);
    }
  },
};

export const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return redactString(error.message);
  }

  return redactString(
    util.inspect(error, {
      depth: 2,
      breakLength: 120,
    })
  );
};

export default logger;