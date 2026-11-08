export interface Account {
  id: string;
  passwordHash: string;
  email: string;
  createdAt: Date;
}

/** One `@`, something before it, and a domain with a dot inside it. Nothing is sent to the address, so this only catches a slip of the keyboard. */
const EMAIL_ADDRESS = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/u;

/**
 * A control character, or a surrogate standing alone. Postgres refuses a NUL. A lone surrogate
 * reaches it as U+FFFD, so two spellings that differ only there would be one account.
 */
const UNHOLDABLE_CHARACTER = /[\p{Cc}\p{Cs}]/u;

export function isEmailAddress(email: string): boolean {
  return !holdsUnholdableCharacter(email) && EMAIL_ADDRESS.test(email);
}

/** Whether `email` holds a character no account's email can, so a login can refuse it before anything is counted. */
export function holdsUnholdableCharacter(email: string): boolean {
  return UNHOLDABLE_CHARACTER.test(email);
}
