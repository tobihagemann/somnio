import { describe, expect, it } from 'vitest';
import {
  ADMIN_REQUEST_TAGS,
  ADMIN_RESPONSE_TAGS,
  UnrecognizedTagError,
  WireDecodingError,
  decodeAdminRequest,
  decodeAdminResponse,
  encodeAdminRequest,
  encodeAdminResponse,
} from '../src/index.ts';
import type { AdminRequest, AdminResponse } from '../src/index.ts';

/**
 * The admin channel dispatches on a string `tag` with payload-bearing variants carrying a `payload`
 * string. Round trips confirm every variant's tag and payload survive the wire form; the tag-string
 * pins guard the discriminator names the CLI and server share, which have no golden fixture.
 */

const REQUESTS: AdminRequest[] = [
  { tag: 'log' },
  { tag: 'weblog' },
  { tag: 'players' },
  { tag: 'time' },
  { tag: 'say', payload: 'hello' },
  { tag: 'kick', payload: 'Saibot' },
  { tag: 'version' },
  { tag: 'logRemove' },
  { tag: 'weblogRemove' },
];

const RESPONSES: AdminResponse[] = [
  { tag: 'logContents', payload: 'log...' },
  { tag: 'weblogContents', payload: 'web...' },
  { tag: 'logEmpty' },
  { tag: 'logRemoved' },
  { tag: 'weblogEmpty' },
  { tag: 'weblogRemoved' },
  { tag: 'playerCount', payload: '12' },
  { tag: 'worldClock', payload: '12:00' },
  { tag: 'sayBroadcast', payload: 'shutdown soon' },
  { tag: 'kickedPlayer', payload: 'Saibot' },
  { tag: 'kickedPlayerNotFound', payload: 'Eve' },
  { tag: 'versionString', payload: '1.0.0' },
  { tag: 'unknownCommand' },
];

describe('admin codec', () => {
  it.each(REQUESTS)('request %j round trips', (request) => {
    expect(decodeAdminRequest(encodeAdminRequest(request))).toEqual(request);
  });

  it.each(RESPONSES)('response %j round trips', (response) => {
    expect(decodeAdminResponse(encodeAdminResponse(response))).toEqual(response);
  });

  it('covers every request and response tag', () => {
    expect(REQUESTS.map((request) => request.tag)).toEqual([...ADMIN_REQUEST_TAGS]);
    expect(RESPONSES.map((response) => response.tag)).toEqual([...ADMIN_RESPONSE_TAGS]);
  });

  it('rejects an unrecognized request tag', () => {
    expect(() => decodeAdminRequest('{"tag":"bogus"}')).toThrow(UnrecognizedTagError);
  });

  it('rejects an unrecognized response tag', () => {
    expect(() => decodeAdminResponse('{"tag":"bogus"}')).toThrow(UnrecognizedTagError);
  });

  it('rejects a payload-bearing verb without its payload', () => {
    expect(() => decodeAdminRequest('{"tag":"say"}')).toThrow(WireDecodingError);
    expect(() => decodeAdminResponse('{"tag":"logContents"}')).toThrow(WireDecodingError);
  });

  /**
   * Pins the wire keys, which the round trips cannot: they encode and decode through the same
   * renamed key. The gameplay union is protected from this by the golden frames; the admin union
   * has no fixture, and the CLI ships separately from the server, so a rename would break every
   * already-installed CLI with a green suite.
   */
  it('keeps the tag and payload keys stable and omits payload on bare verbs', () => {
    expect(JSON.parse(encodeAdminRequest({ tag: 'say', payload: 'hello' }))).toEqual({
      tag: 'say',
      payload: 'hello',
    });
    expect(JSON.parse(encodeAdminResponse({ tag: 'logContents', payload: 'hello' }))).toEqual({
      tag: 'logContents',
      payload: 'hello',
    });
    expect(Object.keys(JSON.parse(encodeAdminRequest({ tag: 'log' })) as object)).toEqual(['tag']);
    expect(Object.keys(JSON.parse(encodeAdminResponse({ tag: 'unknownCommand' })) as object)).toEqual(['tag']);
  });

  it('pins the request tag strings', () => {
    expect([...ADMIN_REQUEST_TAGS]).toEqual(['log', 'weblog', 'players', 'time', 'say', 'kick', 'version', 'logRemove', 'weblogRemove']);
  });

  it('pins the response tag strings', () => {
    expect([...ADMIN_RESPONSE_TAGS]).toEqual([
      'logContents',
      'weblogContents',
      'logEmpty',
      'logRemoved',
      'weblogEmpty',
      'weblogRemoved',
      'playerCount',
      'worldClock',
      'sayBroadcast',
      'kickedPlayer',
      'kickedPlayerNotFound',
      'versionString',
      'unknownCommand',
    ]);
  });
});
