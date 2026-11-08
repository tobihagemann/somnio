import { describe, expect, it } from 'vitest';
import { isEmailAddress } from '../src/domain/account.ts';

describe('an email address', () => {
  it('needs one @, something before it, and a dot inside the domain', () => {
    expect(['ida@example.com', 'ida.saibot@mail.example.de', 'ïda@exämple.de'].map(isEmailAddress)).toEqual([true, true, true]);
    expect(['ida', 'ida@example', '@example.com', 'ida@@example.com', 'ida@.com', 'ida @example.com'].map(isEmailAddress)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  /** A lone surrogate reaches Postgres as U+FFFD, so two such spellings would be one account under two account budgets. */
  it('holds no control character and no surrogate standing alone', () => {
    expect(['ida\u0001@example.com', 'ida@example.com\u0000', 'x\uD800@example.de', 'x\uDC00@example.de'].map(isEmailAddress)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(isEmailAddress('x😀@example.de')).toBe(true);
  });
});
