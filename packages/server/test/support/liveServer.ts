import { Hono } from 'hono';
import { WebSocket } from 'ws';
import type { ClientOptions, RawData } from 'ws';
import { MAX_WIRE_FRAME_SIZE, decodeSomnioMessage } from '@somnio/protocol';
import type { SomnioMessage } from '@somnio/protocol';
import { rawDataToBuffer } from '../../src/connection/connectionActor.ts';
import type { ConnectionDependencies } from '../../src/connection/dependencies.ts';
import type { AdminDependencies } from '../../src/handlers/adminDispatcher.ts';
import { startServer } from '../../src/http/server.ts';
import type { RunningServer } from '../../src/http/server.ts';
import { makeAdminDependencies } from './adminDependencies.ts';
import { testLogger } from './logger.ts';
import { makeStubConnectionDependencies } from './stubDependencies.ts';

export interface LiveServerOptions {
  dependencies?: ConnectionDependencies;
  adminDependencies?: AdminDependencies;
  adminToken?: string;
  app?: Hono;
}

export const TEST_ADMIN_TOKEN = 'secret';

/**
 * Binds the real HTTP server on an ephemeral port, runs `body`, then terminates every open
 * socket and closes. Vitest's per-test timeout is the only bound.
 */
export async function withLiveServer<T>(options: LiveServerOptions, body: (server: RunningServer) => Promise<T>): Promise<T> {
  const dependencies = options.dependencies ?? (await makeStubConnectionDependencies());
  const adminDependencies = options.adminDependencies ?? (await makeAdminDependencies());
  const app = options.app ?? new Hono().get('/admin', (context) => context.text('Unauthorized', 401));
  const server = await startServer({
    app,
    host: '127.0.0.1',
    port: 0,
    adminToken: options.adminToken ?? TEST_ADMIN_TOKEN,
    dependencies,
    adminDependencies,
    logger: testLogger(),
  });
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

function textOf(data: RawData): string {
  return rawDataToBuffer(data).toString('utf8');
}

export interface CloseInfo {
  code: number;
  reason: string;
}

/** A `ws` socket with the frames it received queued for sequential awaits and its close recorded. */
export class TestClient {
  readonly socket: WebSocket;
  readonly closed: Promise<CloseInfo>;
  private readonly received: string[] = [];
  private readonly waiters: ((frame: string) => void)[] = [];
  private closeInfo: CloseInfo | undefined;

  constructor(url: string, options: ClientOptions = {}) {
    this.socket = new WebSocket(url, { maxPayload: MAX_WIRE_FRAME_SIZE * 4, ...options });
    this.socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = textOf(data);
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(text);
      else this.received.push(text);
    });
    this.socket.on('error', () => {
      // `close` follows an abrupt teardown; the close handler resolves.
    });
    this.closed = new Promise((resolve) => {
      this.socket.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString('utf8') };
        resolve(this.closeInfo);
      });
    });
  }

  static async open(url: string, options: ClientOptions = {}): Promise<TestClient> {
    const client = new TestClient(url, options);
    await new Promise<void>((resolve, reject) => {
      client.socket.once('open', resolve);
      client.socket.once('error', reject);
      client.socket.once('unexpected-response', (_request, response) => reject(new Error(`upgrade rejected with ${response.statusCode}`)));
    });
    return client;
  }

  send(frame: string | Buffer): void {
    this.socket.send(frame);
  }

  /** The next text frame; rejects once the socket closes with nothing queued. */
  nextText(timeoutMs = 10_000): Promise<string> {
    const queued = this.received.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame within the timeout')), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      void this.closed.then(() => {
        clearTimeout(timer);
        reject(new Error(`socket closed (${this.closeInfo?.code ?? 'unknown'}) before a frame arrived`));
      });
    });
  }

  async next(timeoutMs = 10_000): Promise<SomnioMessage> {
    return decodeSomnioMessage(await this.nextText(timeoutMs));
  }

  /** Reads frames until one carries `tag`, returning it and everything before it. */
  async until(tag: SomnioMessage['tag'], timeoutMs = 10_000): Promise<{ target: SomnioMessage; before: SomnioMessage[] }> {
    const before: SomnioMessage[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const message = await this.next(Math.max(1, deadline - Date.now()));
      if (message.tag === tag) return { target: message, before };
      before.push(message);
    }
    throw new Error(`no ${tag} frame within the timeout`);
  }

  /** Every text frame received until the socket closes. */
  async drainUntilClose(): Promise<string[]> {
    const frames: string[] = [...this.received];
    this.received.length = 0;
    const collector = (data: RawData, isBinary: boolean) => {
      if (!isBinary) frames.push(textOf(data));
    };
    this.socket.on('message', collector);
    await this.closed;
    return frames;
  }

  close(code = 1000): Promise<CloseInfo> {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(code);
    return this.closed;
  }
}

export function gameplayURL(server: RunningServer): string {
  return `ws://127.0.0.1:${server.port}/ws`;
}

export function adminURL(server: RunningServer): string {
  return `ws://127.0.0.1:${server.port}/admin`;
}

export function bearer(token: string): ClientOptions {
  return { headers: { authorization: `Bearer ${token}` } };
}

/** Resolves with `'opened'` when the upgrade succeeds, or the HTTP status the server refused it with. */
export function attemptUpgrade(url: string, options: ClientOptions = {}): Promise<'opened' | number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once('open', () => {
      socket.close();
      resolve('opened');
    });
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once('error', (error) => {
      if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
      reject(error);
    });
  });
}
