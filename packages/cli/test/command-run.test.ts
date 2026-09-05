import { describe, expect, it } from 'vitest';
import type { AdminRequest, AdminResponse } from '@somnio/protocol';
import { EXIT_FAILURE, EXIT_USAGE, run } from '../src/commandTree.ts';
import { AdminTransportError } from '../src/transport.ts';

interface Captured {
  out: string[];
  err: string[];
  sent: { request: AdminRequest; url: string; token: string }[];
}

function harness(reply: AdminResponse | Error, env: Record<string, string | undefined> = {}) {
  const captured: Captured = { out: [], err: [], sent: [] };
  const io = {
    stdout: (line: string) => captured.out.push(line),
    stderr: (line: string) => captured.err.push(line),
    env,
    send: (request: AdminRequest, url: string, token: string) => {
      captured.sent.push({ request, url, token });
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
  return { captured, io };
}

describe('run', () => {
  it('prints the rendered response and exits 0', async () => {
    const { captured, io } = harness({ tag: 'playerCount', payload: '1' });
    expect(await run(['players'], io)).toBe(0);
    expect(captured.out).toEqual(['Number of players on the server: 1']);
    expect(captured.sent[0]).toEqual({
      request: { tag: 'players' },
      url: 'ws://127.0.0.1:17662/admin',
      token: 'dev-admin',
    });
  });

  it('a transport error prints the error line and exits 1', async () => {
    const { captured, io } = harness(new AdminTransportError('connectFailed', new Error('ECONNREFUSED')));
    expect(await run(['players'], io)).toBe(EXIT_FAILURE);
    expect(captured.out[0]).toBe('The error AdminTransportError: connectFailed: ECONNREFUSED occurred.');
  });

  it('a validation error exits 64 without sending', async () => {
    const { captured, io } = harness({ tag: 'playerCount', payload: '1' });
    expect(await run(['players', '--server-url', 'ws://prod.example/admin'], io)).toBe(EXIT_USAGE);
    expect(captured.sent).toEqual([]);
    expect(captured.err[0]).toContain('plaintext');
  });

  it("an unknown verb exits 64 with commander's message on stderr", async () => {
    const { captured, io } = harness({ tag: 'playerCount', payload: '1' });
    expect(await run(['bogus'], io)).toBe(EXIT_USAGE);
    expect(captured.sent).toEqual([]);
    expect(captured.err.join('\n')).toContain("unknown command 'bogus'");
  });

  it.each([[[]], [['help', 'bogus']]])('%j prints usage on stderr and exits 64', async (argv) => {
    const { captured, io } = harness({ tag: 'playerCount', payload: '1' });
    expect(await run(argv, io)).toBe(EXIT_USAGE);
    expect(captured.out).toEqual([]);
    expect(captured.err.join('\n')).toContain('Usage: somniocli');
  });

  it('kick without a name exits 64', async () => {
    const { captured, io } = harness({ tag: 'kickedPlayer', payload: 'x' });
    expect(await run(['kick'], io)).toBe(EXIT_USAGE);
    expect(captured.sent).toEqual([]);
    expect(captured.err.join('\n')).toContain('missing required argument');
  });

  it.each([
    [['log'], { tag: 'log' }],
    [['weblog'], { tag: 'weblog' }],
    [['players'], { tag: 'players' }],
    [['time'], { tag: 'time' }],
    [['version'], { tag: 'version' }],
    [['log', 'rm'], { tag: 'logRemove' }],
    [['weblog', 'rm'], { tag: 'weblogRemove' }],
    [['say', 'hello', 'world'], { tag: 'say', payload: 'hello world' }],
    [['kick', 'Saibot'], { tag: 'kick', payload: 'Saibot' }],
  ])('%j sends its request', async (argv, request) => {
    const { captured, io } = harness({ tag: 'versionString', payload: '1.0.0' });
    await run(argv, io);
    expect(captured.sent.map((entry) => entry.request)).toEqual([request]);
  });

  it.each([
    [['players', '--server-url', 'wss://x.example/admin']],
    [['--server-url', 'wss://x.example/admin', 'players']],
    [['log', 'rm', '--server-url', 'wss://x.example/admin']],
  ])('%j dials the given URL', async (argv) => {
    const { captured, io } = harness({ tag: 'versionString', payload: '1.0.0' }, { SOMNIO_ADMIN_TOKEN: 'x' });
    expect(await run(argv, io)).toBe(0);
    expect(captured.sent[0]?.url).toBe('wss://x.example/admin');
  });

  it.each([['wss://example.com/admin#x'], ['wss://ex%41mple.com/admin']])(
    'a URL the host-agreement gate refuses (%s) exits 64 without sending',
    async (url) => {
      const { captured, io } = harness({ tag: 'playerCount', payload: '1' }, { SOMNIO_ADMIN_TOKEN: 'x' });
      expect(await run(['players', '--server-url', url], io)).toBe(EXIT_USAGE);
      expect(captured.sent).toEqual([]);
      expect(captured.err[0]).toBe('--server-url is not a valid URL.');
    },
  );

  it('the exit codes are the POSIX values', () => {
    expect(EXIT_USAGE).toBe(64);
    expect(EXIT_FAILURE).toBe(1);
  });

  it.each([['--help'], ['help']])('%s prints the root help and exits 0', async (verb) => {
    const { captured, io } = harness({ tag: 'playerCount', payload: '1' });
    expect(await run([verb], io)).toBe(0);
    expect(captured.out.join('\n')).toContain('Usage: somniocli');
    expect(captured.err).toEqual([]);
  });

  it.each([
    ['log', '--help'],
    ['help', 'log'],
  ])('%s %s prints the log command help, which lists rm', async (first, second) => {
    const { captured, io } = harness({ tag: 'playerCount', payload: '1' });
    expect(await run([first, second], io)).toBe(0);
    const text = captured.out.join('\n');
    expect(text).toContain('Usage: somniocli log');
    expect(text).toContain('rm');
  });

  it('a remote URL without a token exits 64 without sending', async () => {
    const { captured, io } = harness({ tag: 'playerCount', payload: '1' });
    expect(await run(['players', '--server-url', 'wss://prod.example/admin'], io)).toBe(EXIT_USAGE);
    expect(captured.sent).toEqual([]);
    expect(captured.err[0]).toBe('SOMNIO_ADMIN_TOKEN environment variable is required.');
  });

  it('an empty say returns before connecting', async () => {
    const { captured, io } = harness({ tag: 'sayBroadcast', payload: '' });
    expect(await run(['say'], io)).toBe(0);
    expect(captured.sent).toEqual([]);
  });

  it('renders in German when the environment asks for it', async () => {
    const { captured, io } = harness({ tag: 'logRemoved' }, { LANG: 'de_DE.UTF-8' });
    expect(await run(['log', 'rm'], io)).toBe(0);
    expect(captured.out).toEqual(['Log Datei wurde gelöscht.']);
  });
});
