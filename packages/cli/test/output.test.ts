import { describe, expect, it } from 'vitest';
import { catalogViolations } from '@somnio/core/catalog';
import { RENDERED_KEYS, cliCatalog, localize, resolveLocale } from '../src/catalog.ts';
import { parseWorldClock, render } from '../src/output.ts';

describe('render', () => {
  it.each([
    [{ tag: 'logEmpty' }, 'Log file is empty or does not exist.'],
    [{ tag: 'logRemoved' }, 'Log file deleted.'],
    [{ tag: 'weblogEmpty' }, 'WebLog file is empty or does not exist.'],
    [{ tag: 'weblogRemoved' }, 'WebLog file deleted.'],
    [{ tag: 'unknownCommand' }, 'Unknown command.'],
    [{ tag: 'logContents', payload: 'raw\nbody' }, 'raw\nbody'],
    [{ tag: 'weblogContents', payload: 'admin\nbody' }, 'admin\nbody'],
    [{ tag: 'playerCount', payload: '12' }, 'Number of players on the server: 12'],
    [{ tag: 'sayBroadcast', payload: 'hi' }, 'Broadcast message: hi'],
    [{ tag: 'kickedPlayer', payload: 'Saibot' }, 'Saibot was kicked from the server.'],
    [{ tag: 'kickedPlayerNotFound', payload: 'Eve' }, 'Eve could not be found on the server.'],
    [{ tag: 'versionString', payload: '1.0.0' }, 'The server is running version: 1.0.0'],
    [{ tag: 'worldClock', payload: '1;2;3;04;05;06' }, 'It is the year 1, the month 2, the day 3 and the time is 04:05:06.'],
    [{ tag: 'worldClock', payload: '1;2;3;4;5' }, 'The error 1;2;3;4;5 occurred.'],
    [{ tag: 'worldClock', payload: 'a;b;c;d;e;f' }, 'The error a;b;c;d;e;f occurred.'],
    [{ tag: 'worldClock', payload: 'malformed' }, 'The error malformed occurred.'],
  ] as const)('renders %j in English', (response, expected) => {
    expect(render(response, 'en')).toBe(expected);
  });

  it('renders the German world clock with positional placeholders', () => {
    expect(render({ tag: 'worldClock', payload: '1;2;3;04;05;06' }, 'de')).toBe('Wir schreiben das Jahr 1, den Monat 2, den Tag 3 und es ist 04:05:06 Uhr.');
  });

  it('renders the German player count', () => {
    expect(render({ tag: 'playerCount', payload: '3' }, 'de')).toBe('Anzahl an Spieler im Server: 3');
  });
});

describe('parseWorldClock', () => {
  it('returns six raw substrings on success', () => {
    expect(parseWorldClock('10;20;30;04;05;06')).toEqual({
      year: '10',
      month: '20',
      day: '30',
      hour: '04',
      minute: '05',
      second: '06',
    });
  });

  it('rejects a field count other than six', () => {
    expect(parseWorldClock('1;2;3;4;5')).toBeUndefined();
    expect(parseWorldClock('1;2;3;4;5;6;7')).toBeUndefined();
  });

  it('rejects non-integer fields', () => {
    expect(parseWorldClock('a;2;3;4;5;6')).toBeUndefined();
  });
});

describe('catalog', () => {
  it('carries the twelve rendered keys', () => {
    expect(RENDERED_KEYS.length).toBe(12);
  });

  it('satisfies every catalog rule for the rendered keys', () => {
    expect(catalogViolations(cliCatalog, RENDERED_KEYS)).toEqual([]);
  });

  it('every key doubles as its own English value, so a miss reads as English', () => {
    for (const key of RENDERED_KEYS) expect(cliCatalog.en[key]).toBe(key);
    expect(localize('Not a catalog key %@', 'de', 'x')).toBe('Not a catalog key x');
  });

  it.each([
    [{ LANG: 'de_DE.UTF-8' }, 'de'],
    [{ LC_ALL: 'de_AT.UTF-8', LANG: 'en_US.UTF-8' }, 'de'],
    [{ LANG: 'en_US.UTF-8' }, 'en'],
    [{ LC_MESSAGES: 'C' }, 'en'],
    [{}, 'en'],
  ])('resolves the locale from %j', (env, expected) => {
    expect(resolveLocale(env)).toBe(expected);
  });
});
