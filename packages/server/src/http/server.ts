import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { MAX_WIRE_FRAME_SIZE } from '@somnio/protocol';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { runAdminConnection } from '../admin/adminConnection.ts';
import { ConnectionActor, socketFromWebSocket } from '../connection/connectionActor.ts';
import type { ConnectionDependencies } from '../connection/dependencies.ts';
import type { AdminDependencies } from '../handlers/adminDispatcher.ts';
import type { Logger } from '../logging.ts';
import { timingSafeBearer } from './app.ts';

export interface ServerOptions {
  app: Hono;
  host: string;
  port: number;
  adminToken: string;
  dependencies: ConnectionDependencies;
  adminDependencies: AdminDependencies;
  logger: Logger;
}

export interface RunningServer {
  port: number;
  /**
   * Terminates every open WebSocket, waits for each connection's exit path (its disconnect
   * checkpoint included) to finish, then closes the HTTP server — so nothing touches the
   * database after this resolves.
   */
  close(): Promise<void>;
}

const CRLF = '\r\n';

/**
 * Binds the HTTP server and routes `upgrade` requests: `/ws` to a `ConnectionActor`, `/admin` to
 * the admin connection behind the bearer gate (a missing or wrong bearer answers 401 before the
 * upgrade), anything else 404. `maxPayload` is the wire frame ceiling, so a frame above it closes
 * 1009 before the decoder runs; the 64-byte slack window between it and `maxFrameLength` reaches
 * the decoder, whose own cap closes 1002.
 */
export function startServer(options: ServerOptions): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<WebSocket>();
    const connections = new Set<Promise<void>>();
    let closing = false;
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WIRE_FRAME_SIZE });
    const server = serve({ fetch: options.app.fetch, hostname: options.host, port: options.port }, (info) => {
      resolve({
        port: info.port,
        close: async () => {
          // Refuse upgrades first: a connection accepted while the set below is awaited would
          // be neither terminated nor awaited, and could still be querying at `db.destroy()`.
          closing = true;
          for (const socket of sockets) socket.terminate();
          await Promise.all(connections);
          wss.close();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    }) as Server;
    server.once('error', reject);
    // A socket error (an over-cap payload, a reset) is emitted on the socket; unhandled it
    // would take the process down. `ws` closes the socket itself right after.
    const track = (ws: WebSocket, logger: Logger, run: () => Promise<void>) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', (error) => logger.warn({ error: String(error) }, 'websocket error'));
      const connection = run().finally(() => connections.delete(connection));
      connections.add(connection);
    };
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (closing) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      // Node's parser passes request targets `URL` refuses (`//[/`); unhandled, that throw
      // would take the process down before the bearer gate runs.
      let path: string;
      try {
        path = new URL(request.url ?? '/', 'http://localhost').pathname;
      } catch {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }
      if (path === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          track(ws, options.dependencies.logger, () => new ConnectionActor(options.dependencies).runConnection(socketFromWebSocket(ws)));
        });
        return;
      }
      if (path === '/admin') {
        if (!timingSafeBearer(request.headers.authorization, options.adminToken)) {
          options.logger.warn({ reason: 'missing_or_bad_token' }, 'rejected /admin upgrade');
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          track(ws, options.logger, () => runAdminConnection(ws, options.adminDependencies));
        });
        return;
      }
      rejectUpgrade(socket, 404, 'Not Found');
    });
  });
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}${CRLF}Connection: close${CRLF}Content-Length: 0${CRLF}${CRLF}`);
  socket.destroy();
}
