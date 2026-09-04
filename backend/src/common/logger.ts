import { mkdirSync } from 'node:fs';
import log4js, { type Appender } from 'log4js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LEVELS)[number];

let configured = false;

function format(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isLogLevel(value: string): value is LogLevel {
  return (LEVELS as readonly string[]).includes(value);
}

/** Configures log4js once: console plus rolling files. */
export function configureLogging(options?: {
  level?: string;
  logDir?: string;
}): void {
  if (configured) {
    return;
  }
  configured = true;
  const rawLevel = (options?.level ?? process.env.BUSAGENT_LOG_LEVEL ?? 'info').toLowerCase();
  const level: LogLevel = isLogLevel(rawLevel) ? rawLevel : 'info';
  const logDir = options?.logDir ?? process.env.BUSAGENT_LOG_DIR ?? 'logs';
  const inTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

  const appenders: Record<string, Appender> = {
    console: {
      type: 'stdout',
      layout: {
        type: 'pattern',
        pattern: '%d{yyyy-MM-dd hh:mm:ss.SSS} [%p] %c - %m',
      },
    },
  };
  const used = ['console'];
  if (!inTest) {
    mkdirSync(logDir, { recursive: true });
    appenders.file = {
      type: 'dateFile',
      filename: `${logDir}/busagent.log`,
      pattern: 'yyyy-MM-dd',
      keepFileExt: true,
      numBackups: 14,
      layout: {
        type: 'pattern',
        pattern: '%d{yyyy-MM-dd hh:mm:ss.SSS} [%p] %c - %m',
      },
    };
    used.push('file');
  }

  log4js.configure({
    appenders,
    categories: {
      default: { appenders: used, level },
    },
  });
}

/**
 * Application logger wrapping log4js (log4j-style categories and levels).
 * Use `new Logger('Category')` in services instead of Nest's Logger.
 */
export class Logger {
  private readonly inner: log4js.Logger;

  constructor(category = 'BusAgent') {
    if (!configured) {
      configureLogging();
    }
    this.inner = log4js.getLogger(category);
  }

  trace(message: unknown, ...args: unknown[]): void {
    this.inner.trace(this.line(message, args));
  }

  debug(message: unknown, ...args: unknown[]): void {
    this.inner.debug(this.line(message, args));
  }

  info(message: unknown, ...args: unknown[]): void {
    this.inner.info(this.line(message, args));
  }

  warn(message: unknown, ...args: unknown[]): void {
    this.inner.warn(this.line(message, args));
  }

  error(message: unknown, ...args: unknown[]): void {
    this.inner.error(this.line(message, args));
  }

  fatal(message: unknown, ...args: unknown[]): void {
    this.inner.fatal(this.line(message, args));
  }

  private line(message: unknown, args: unknown[]): string {
    return [message, ...args].filter((value) => value !== undefined).map(format).join(' ');
  }
}
