import { describe, expect, it } from 'vitest';
import { dialogSteps } from '../src/npcDialog.ts';

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
