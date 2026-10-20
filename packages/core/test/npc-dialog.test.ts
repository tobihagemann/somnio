import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import { catalogViolations, readCatalog } from '../src/i18n/catalog.ts';
import { dialogLine, dialogLineFits, dialogSteps, localizedDialogLine } from '../src/npcDialog.ts';
import dialogJSON from '../data/dialog.json' with { type: 'json' };
import { loadSectorFixtures } from './support/sectorFixture.ts';

const SAY = SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes;
const NAME = SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes;

describe('dialog steps', () => {
  it('yields one entry for a script with no separator', () => {
    expect(dialogSteps('Hello, $name.')).toEqual(['Hello, $name.']);
  });

  it('splits on the separator', () => {
    expect(dialogSteps('Step one.\n---\nStep two.')).toEqual(['Step one.', 'Step two.']);
  });

  it('preserves internal whitespace and trims only one newline per side', () => {
    expect(dialogSteps('\n  hi   $name\t\n')).toEqual(['  hi   $name\t']);
  });

  it('yields nothing for an empty script', () => {
    expect(dialogSteps('')).toEqual([]);
  });
});

describe('dialog lines', () => {
  it('writes the name wherever the step asks for it', () => {
    expect(dialogLine('$name! Welcome, $name.', 'Mira')).toBe('Mira! Welcome, Mira.');
  });

  it('writes a name that reads as a replacement pattern as it is', () => {
    expect(dialogLine('Hello, $name.', "$&$'$`$$")).toBe("Hello, $&$'$`$$.");
  });

  it.each([
    ['no name, at the cap', 'a'.repeat(SAY), true],
    ['no name, one byte over', 'a'.repeat(SAY + 1), false],
    ['one name, at the cap once it is the longest name', `${'a'.repeat(SAY - NAME)}$name`, true],
    ['one name, one byte over once it is the longest name', `${'a'.repeat(SAY - NAME + 1)}$name`, false],
    ['one name, at the cap only as written', `${'a'.repeat(SAY - '$name'.length)}$name`, false],
    ['two names, at the cap once they are the longest name', `$name${'a'.repeat(SAY - 2 * NAME)}$name`, true],
    ['two names, one byte over once they are the longest name', `$name${'a'.repeat(SAY - 2 * NAME + 1)}$name`, false],
    ['two-byte characters, at the cap', `${'ü'.repeat((SAY - NAME) / 2)}$name`, true],
    ['two-byte characters, one character over', `${'ü'.repeat((SAY - NAME) / 2 + 1)}$name`, false],
  ])('judges a step with %s by its longest line', (_case, step, fits) => {
    expect(dialogLineFits(step)).toBe(fits);
    expect(utf8ByteLength(dialogLine(step, 'n'.repeat(NAME))) <= SAY).toBe(fits);
  });

  it('measures the longest line as the one spoken to a name at the identifier cap', () => {
    expect(utf8ByteLength(dialogLine(`${'a'.repeat(SAY - NAME)}$name`, 'n'.repeat(NAME)))).toBe(256);
  });
});

describe('the dialog catalog', () => {
  const steps = loadSectorFixtures().flatMap((sector) => sector.npcs.flatMap((npc) => dialogSteps(npc.dialogScript)));
  const names = (line: string): number => line.split('$name').length - 1;

  it('translates every step a committed NPC says', () => {
    expect(steps.filter((step) => !Object.hasOwn(dialogJSON, step))).toEqual([]);
  });

  it.each(Object.entries(dialogJSON))('keeps %j English as its key, naming the dreamer as often in German, within the say cap', (step, { en, de }) => {
    expect(en).toBe(step);
    expect(names(de)).toBe(names(step));
    expect(dialogLineFits(de)).toBe(true);
  });

  it('holds every translation to the rules of every catalog', () => {
    expect(catalogViolations(readCatalog(dialogJSON), Object.keys(dialogJSON))).toEqual([]);
  });

  it('says a step in the language asked for, and one it does not hold as written', () => {
    expect(localizedDialogLine('Welcome, $name!', 'de', 'Mira')).toBe('Willkommen, Mira!');
    expect(localizedDialogLine('Welcome, $name!', 'en', 'Mira')).toBe('Welcome, Mira!');
    expect(localizedDialogLine('Hello, $name.', 'de', 'Mira')).toBe('Hello, Mira.');
    expect(localizedDialogLine('constructor', 'de', 'Mira')).toBe('constructor');
  });
});
