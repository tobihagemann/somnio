import { UnrecognizedTagError, decodeAdminRequest, encodeAdminResponse } from '@somnio/protocol';
import type { AdminResponse } from '@somnio/protocol';
import type { WebSocket } from 'ws';
import { CLOSE_PROTOCOL_ERROR, FRAME_VALIDATION_FAILED, rawDataToBuffer } from '../connection/connectionActor.ts';
import { dispatchAdminRequest } from '../handlers/adminDispatcher.ts';
import type { AdminDependencies } from '../handlers/adminDispatcher.ts';

export type AdminProcessOutcome = { kind: 'write'; response: AdminResponse } | { kind: 'ignore' } | { kind: 'closeProtocolError'; reason: string };

/**
 * One inbound admin text frame: decoded, dispatched, and answered inline (the admin protocol is
 * request/response with no fan-out). An unknown verb answers `unknownCommand` and stays open — a
 * CLI built against a newer server must not tear the session down — while a malformed frame
 * closes 1002.
 */
export function processAdminText(text: string, dependencies: AdminDependencies): AdminProcessOutcome {
  try {
    const request = decodeAdminRequest(text);
    const response = dispatchAdminRequest(request, dependencies);
    return response === undefined ? { kind: 'ignore' } : { kind: 'write', response };
  } catch (error) {
    if (error instanceof UnrecognizedTagError) return { kind: 'write', response: { tag: 'unknownCommand' } };
    dependencies.logger.warn({ error: String(error), frame_size: Buffer.byteLength(text, 'utf8') }, 'admin frame validation failed');
    return { kind: 'closeProtocolError', reason: FRAME_VALIDATION_FAILED };
  }
}

/** Drives one admin socket; resolves when the socket closes. */
export function runAdminConnection(ws: WebSocket, dependencies: AdminDependencies): Promise<void> {
  return new Promise((resolve) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        dependencies.logger.error('admin received binary frame; closing');
        ws.close(CLOSE_PROTOCOL_ERROR, 'binary frames are not part of the wire protocol');
        return;
      }
      const text = rawDataToBuffer(data).toString('utf8');
      const outcome = processAdminText(text, dependencies);
      switch (outcome.kind) {
        case 'write':
          ws.send(encodeAdminResponse(outcome.response), (error) => {
            if (error) {
              dependencies.logger.warn({ error: String(error), case: outcome.response.tag }, 'admin response write failed');
            }
          });
          return;
        case 'ignore':
          return;
        case 'closeProtocolError':
          ws.close(CLOSE_PROTOCOL_ERROR, outcome.reason);
          return;
      }
    });
    ws.on('close', () => {
      dependencies.logger.debug('admin connection closed by peer');
      resolve();
    });
  });
}
