import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { SomnioMessage } from '@somnio/protocol';
import { encodeOrWarn } from '../src/connection/encodeFrame.ts';
import { ConnectionOutbox, collectOutbox } from '../src/connection/outbox.ts';

function recordingLogger() {
  const records: Record<string, unknown>[] = [];
  const logger = pino({ level: 'debug' }, { write: (chunk: string) => records.push(JSON.parse(chunk) as Record<string, unknown>) });
  return { logger, records };
}

const oversized: SomnioMessage = {
  tag: 'serverSay',
  payload: { entityIndex: 1, text: 'x'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1) },
};

/** The single outbound encode path: an oversized frame is dropped and logged, never thrown into a broadcast loop. */
describe('encodeOrWarn', () => {
  it('encodes a frame that fits', () => {
    const { logger, records } = recordingLogger();
    expect(encodeOrWarn({ tag: 'leave', payload: { entityIndex: 3, leftGame: true } }, logger)).toContain('"leave"');
    expect(records).toEqual([]);
  });

  it('drops an oversized frame with a warn naming its tag', () => {
    const { logger, records } = recordingLogger();
    expect(encodeOrWarn(oversized, logger)).toBeUndefined();
    expect(records).toMatchObject([{ level: 40, tag: 'serverSay', msg: 'failed to encode frame' }]);
  });

  it('leaves the outbox untouched when sendEncoded cannot encode', async () => {
    const { logger } = recordingLogger();
    const outbox = new ConnectionOutbox(8);
    outbox.sendEncoded(oversized, logger);
    outbox.sendEncoded({ tag: 'leave', payload: { entityIndex: 3, leftGame: true } }, logger);
    outbox.finish();
    expect((await collectOutbox(outbox)).length).toBe(1);
  });
});
