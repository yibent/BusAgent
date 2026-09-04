import { describe, expect, it } from 'vitest';
import { Logger, configureLogging } from '../src/common/logger.js';

describe('Logger', () => {
  it('writes without throwing', () => {
    configureLogging({ level: 'debug' });
    const logger = new Logger('LoggerTest');
    expect(() => {
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error(new Error('boom'));
    }).not.toThrow();
  });
});
