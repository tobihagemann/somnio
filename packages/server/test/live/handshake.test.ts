import { describe, expect, it } from 'vitest';
import { MAX_WIRE_FRAME_SIZE, SOMNIO_PROTOCOL_CONSTANTS, decodeSomnioMessage, encodeSomnioMessage } from '@somnio/protocol';
import { CLOSE_PROTOCOL_ERROR, FRAME_VALIDATION_FAILED } from '../../src/connection/connectionActor.ts';
import { TestClient, adminURL, attemptUpgrade, gameplayURL, withLiveServer } from '../support/liveServer.ts';

/** Close codes `ws` reports: 1009 is the reassembly guard, 1006 a drop without a close handshake. */
const MESSAGE_TOO_LARGE = 1009;
const ABNORMAL_CLOSURE = 1006;

describe('gameplay handshake over a live socket', () => {
  it('sends hello with the current protocol version on connect', async () => {
    await withLiveServer({}, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      expect(await client.next()).toEqual({
        tag: 'hello',
        payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion },
      });
      await client.close();
    });
  });

  it.each([
    ['a binary frame', (client: TestClient) => client.socket.send(Buffer.from([0x00]), { binary: true })],
    ['malformed JSON', (client: TestClient) => client.send('{ not json')],
    ['an unknown tag of 300 bytes', (client: TestClient) => client.send(`{"tag":"${'x'.repeat(300)}","payload":{}}`)],
    ['a recognized tag with a malformed payload', (client: TestClient) => client.send('{"tag":"clientPosition","payload":{}}')],
    ['a zero-byte text frame', (client: TestClient) => client.send('')],
  ])('closes 1002 with the fixed reason on %s', async (_label, send) => {
    await withLiveServer({}, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      await client.next();
      send(client);
      expect(await client.closed).toEqual({ code: CLOSE_PROTOCOL_ERROR, reason: FRAME_VALIDATION_FAILED });
    });
  });

  it('a frame in the slack window above maxFrameLength reaches the decoder and closes 1002', async () => {
    await withLiveServer({}, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      await client.next();
      client.send('a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1));
      expect((await client.closed).code).toBe(CLOSE_PROTOCOL_ERROR);
    });
  });

  it('a frame past the wire cap closes without reaching the decoder', async () => {
    await withLiveServer({}, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      await client.next();
      client.send('a'.repeat(MAX_WIRE_FRAME_SIZE + 1));
      expect([MESSAGE_TOO_LARGE, ABNORMAL_CLOSURE]).toContain((await client.closed).code);
    });
  });

  it('a valid frame is decoded before the pre-login gate closes the socket', async () => {
    await withLiveServer({}, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      await client.next();
      client.send(encodeSomnioMessage({ tag: 'clientSay', payload: { entityIndex: 0, text: 'conformance' } }));
      expect((await client.closed).code).toBe(CLOSE_PROTOCOL_ERROR);
    });
  });

  it('rejects an admin upgrade without a bearer with 401', async () => {
    await withLiveServer({}, async (server) => {
      expect(await attemptUpgrade(adminURL(server))).toBe(401);
    });
  });

  it('a 404 for an unknown upgrade path', async () => {
    await withLiveServer({}, async (server) => {
      expect(await attemptUpgrade(`ws://127.0.0.1:${server.port}/nope`)).toBe(404);
    });
  });

  it('the hello frame is a text frame that decodes', async () => {
    await withLiveServer({}, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      const text = await client.nextText();
      expect(decodeSomnioMessage(text).tag).toBe('hello');
      await client.close();
    });
  });
});
