import pino from 'pino';
import type { Logger } from '../../src/logging.ts';

/** A logger whose records go nowhere; every unit suite's default. */
export function testLogger(): Logger {
  return pino({ level: 'silent' });
}

/** A logger whose records are collected as parsed JSON, for asserting on what the operator sees. */
export function recordingLogger(): { logger: Logger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const logger = pino({ level: 'debug' }, { write: (chunk: string) => records.push(JSON.parse(chunk) as Record<string, unknown>) });
  return { logger, records };
}
