import pino from 'pino';
import type { Logger } from '../../src/logging.ts';

/** A logger whose records go nowhere; every unit suite's default. */
export function testLogger(): Logger {
  return pino({ level: 'silent' });
}
