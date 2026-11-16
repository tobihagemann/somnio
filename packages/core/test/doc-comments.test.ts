import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('doc comments', () => {
  /**
   * One doc comment runs straight into another when the declaration the first documented was moved
   * or deleted, leaving the first doc on the wrong declaration.
   */
  it('never runs one doc comment straight into another in any package source', () => {
    const files = readdirSync(PACKAGES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        try {
          return sources(join(PACKAGES, entry.name, 'src'));
        } catch {
          return [];
        }
      });
    expect(files.length).toBeGreaterThan(100);
    const stacked = files.flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return [...text.matchAll(/\*\/[ \t]*\n[ \t]*\/\*\*/g)].map((match) => `${path}:${text.slice(0, match.index).split('\n').length}`);
    });
    expect(stacked).toEqual([]);
  });
});
