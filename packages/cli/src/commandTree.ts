import { Command, CommanderError } from 'commander';
import type { AdminRequest, AdminResponse } from '@somnio/protocol';
import { localize, resolveLocale } from './catalog.ts';
import { render } from './output.ts';
import { ValidationError, resolveAdminConnection } from './resolver.ts';
import { send } from './transport.ts';

/** `EX_USAGE`: a validation or parse error, distinct from a transport failure's 1. */
export const EXIT_USAGE = 64;
export const EXIT_FAILURE = 1;

/** The verb an argv slice resolves to. */
interface RoutedVerb {
  request: AdminRequest;
  serverURL: string | undefined;
}

/** Where commander's own output lands: help on `writeOut`, usage errors on `writeErr`. */
interface CommanderOutput {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface CommandIO {
  stdout(line: string): void;
  stderr(line: string): void;
  /** Performs the round trip; the default is the real transport. */
  send?(request: AdminRequest, url: string, token: string): Promise<AdminResponse>;
  env?: Record<string, string | undefined>;
}

/**
 * The admin command tree: `log [rm]`, `weblog [rm]`, `players`, `time`, `say <message...>`,
 * `kick <name>`, `version`, each with a shared `--server-url`. Building it per call keeps
 * commander's parse state out of the tests. Commander renders help for the command that asked
 * (so `log --help` lists `rm`) and its own usage errors, through `output`.
 */
function buildCommandTree(onVerb: (verb: RoutedVerb) => Promise<void>, output: CommanderOutput): Command {
  const program = new Command('somniocli').description('Somnio admin CLI.');
  program.exitOverride().configureOutput(output);
  const withServerURL = (command: Command) => command.option('--server-url <url>', 'Admin WebSocket URL (env: SOMNIO_ADMIN_URL).');
  // Accepted before the verb as well as after it; the verb's own value wins when both are given.
  withServerURL(program);
  const verb = (request: AdminRequest, command: Command) => onVerb({ request, serverURL: command.optsWithGlobals<{ serverUrl?: string }>().serverUrl });

  const log = withServerURL(program.command('log').description('Read the gameplay log.'));
  log.action((_options, command: Command) => verb({ tag: 'log' }, command));
  withServerURL(log.command('rm').description('Delete the gameplay log.')).action((_options, command: Command) => verb({ tag: 'logRemove' }, command));
  const weblog = withServerURL(program.command('weblog').description('Read the admin log.'));
  weblog.action((_options, command: Command) => verb({ tag: 'weblog' }, command));
  withServerURL(weblog.command('rm').description('Delete the admin log.')).action((_options, command: Command) => verb({ tag: 'weblogRemove' }, command));
  withServerURL(program.command('players').description('Show the number of logged-in players.')).action((_options, command: Command) =>
    verb({ tag: 'players' }, command),
  );
  withServerURL(program.command('time').description('Show the in-game world clock.')).action((_options, command: Command) => verb({ tag: 'time' }, command));
  withServerURL(program.command('say').description('Broadcast a message to every logged-in player.'))
    .argument('[message...]')
    .action((message: string[], _options, command: Command) => {
      const joined = message.join(' ');
      // An empty say answers nothing on the wire, so it returns before a connection is opened.
      if (joined.length === 0) return Promise.resolve();
      return verb({ tag: 'say', payload: joined }, command);
    });
  withServerURL(program.command('kick').description('Disconnect a character by name.'))
    .argument('<name>')
    .action((name: string, _options, command: Command) => verb({ tag: 'kick', payload: name }, command));
  withServerURL(program.command('version').description('Show the server version.')).action((_options, command: Command) => verb({ tag: 'version' }, command));
  return program;
}

/** Runs the CLI: resolves the connection, performs the round trip, prints the rendered line; returns the exit code. */
export async function run(argv: readonly string[], io: CommandIO): Promise<number> {
  const locale = resolveLocale(io.env ?? process.env);
  let exitCode = 0;
  const program = buildCommandTree(
    async ({ request, serverURL }) => {
      const connection = resolveAdminConnection(serverURL, io.env ?? process.env);
      try {
        const response = await (io.send ?? send)(request, connection.url, connection.token);
        io.stdout(render(response, locale));
      } catch (error) {
        io.stdout(localize('The error %@ occurred.', locale, String(error)));
        exitCode = EXIT_FAILURE;
      }
    },
    {
      writeOut: (text) => io.stdout(text.replace(/\n$/, '')),
      writeErr: (text) => io.stderr(text.replace(/\n$/, '')),
    },
  );
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander has already written the help or the usage error through `output`. `--help`
      // raises `helpDisplayed`; `help` is raised both by the `help [command]` verb (exit code 0)
      // and by a bare invocation or `help <unknown>` (exit code 1), so the code alone does not
      // separate success from a usage error.
      if (error.code === 'commander.helpDisplayed' || (error.code === 'commander.help' && error.exitCode === 0)) {
        return 0;
      }
      return EXIT_USAGE;
    }
    if (error instanceof ValidationError) {
      io.stderr(error.message);
      return EXIT_USAGE;
    }
    throw error;
  }
  return exitCode;
}
