import type { SpeechKind } from '@somnio/protocol';

/** The commands that pick how a line is spoken, for that line only. `/s` says it as a line with no command would. */
const SPEECH_COMMANDS = new Map<string, SpeechKind>([
  ['w', 'whisper'],
  ['whisper', 'whisper'],
  ['flüstern', 'whisper'],
  ['s', 'say'],
  ['say', 'say'],
  ['sagen', 'say'],
  ['y', 'yell'],
  ['yell', 'yell'],
  ['schreien', 'yell'],
]);

export type ChatInput = { kind: SpeechKind; text: string } | { unknownCommand: string };

/**
 * What the chat field asks for: a line said plainly, or as the kind its leading command
 * names. `undefined` sends nothing: a blank line, a `/` with no command right after it, or a known command with no text.
 */
export function parseChatInput(raw: string): ChatInput | undefined {
  const line = raw.trim();
  if (!line.startsWith('/')) return line === '' ? undefined : { kind: 'say', text: line };
  const [, command = '', text = ''] = /^\/(\S*)\s*(.*)$/s.exec(line) ?? [];
  if (command === '') return undefined;
  const kind = SPEECH_COMMANDS.get(command.toLowerCase());
  if (kind === undefined) return { unknownCommand: `/${command}` };
  return text === '' ? undefined : { kind, text };
}
