import pino, { type Logger as PinoLogger } from "pino";

const level = process.env.LOG_LEVEL ?? "info";

const isProd = process.env.NODE_ENV === "production";

export const logger: PinoLogger = pino({
  level,
  base: undefined,
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
            singleLine: false,
          },
        },
      }),
});

export type Logger = PinoLogger;

export function childLogger(
  name: string,
  bindings: Record<string, unknown> = {},
): Logger {
  return logger.child({ module: name, ...bindings });
}
