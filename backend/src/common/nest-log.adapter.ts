import type { LoggerService } from '@nestjs/common';
import { Logger } from './logger.js';

/** Bridges Nest framework logs into the log4js Logger wrapper. */
export class NestLogAdapter implements LoggerService {
  log(message: unknown, context?: string): void {
    this.for(context).info(message);
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    const category = context ?? (stackOrContext && !stackOrContext.includes('\n') ? stackOrContext : 'Nest');
    const extra = context !== undefined ? stackOrContext : undefined;
    this.for(category).error(message, extra);
  }

  warn(message: unknown, context?: string): void {
    this.for(context).warn(message);
  }

  debug(message: unknown, context?: string): void {
    this.for(context).debug(message);
  }

  verbose(message: unknown, context?: string): void {
    this.for(context).trace(message);
  }

  private for(context: string | undefined): Logger {
    return new Logger(context && context.length > 0 ? context : 'Nest');
  }
}
