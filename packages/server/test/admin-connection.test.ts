import { afterEach, describe, expect, it } from 'vitest';
import { encodeAdminRequest } from '@somnio/protocol';
import { processAdminText } from '../src/admin/adminConnection.ts';
import { makeAdminDependencies } from './support/adminDependencies.ts';
import { tempLogging } from './support/tempLogging.ts';

const logging = tempLogging();
afterEach(() => logging.cleanup());

describe('processAdminText', () => {
  it('unrecognized verb yields write unknownCommand and keeps the loop open', () => {
    const outcome = processAdminText('{"tag":"bogus"}', makeAdminDependencies({ logging }));
    expect(outcome).toEqual({ kind: 'write', response: { tag: 'unknownCommand' } });
  });

  it('a well-formed players request yields write playerCount', () => {
    const outcome = processAdminText(encodeAdminRequest({ tag: 'players' }), makeAdminDependencies({ logging }));
    expect(outcome).toEqual({ kind: 'write', response: { tag: 'playerCount', payload: '0' } });
  });

  it('malformed JSON closes with protocolError', () => {
    const outcome = processAdminText('{ not json', makeAdminDependencies({ logging }));
    expect(outcome).toEqual({ kind: 'closeProtocolError', reason: 'frame validation failed' });
  });

  it('a known verb missing its payload closes with protocolError', () => {
    const outcome = processAdminText('{"tag":"say"}', makeAdminDependencies({ logging }));
    expect(outcome.kind).toBe('closeProtocolError');
  });

  it('an empty say is ignored without a response', () => {
    const outcome = processAdminText(encodeAdminRequest({ tag: 'say', payload: '' }), makeAdminDependencies({ logging }));
    expect(outcome).toEqual({ kind: 'ignore' });
  });
});
