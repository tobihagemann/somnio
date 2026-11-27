import type { Role } from '@somnio/protocol';
import type { Equipment } from './items.ts';

/** Everything a role's set can change, each read where its ability or effect lands. */
export interface SetBonuses {
  /** The share of Cleave's damage on each nightmare it strikes. */
  cleaveShare: number;
  /** The seconds Brace's `braced` lasts beyond its own. */
  bracedSeconds: number;
  /** The share of Lunge's cooldown that runs. */
  lungeCooldown: number;
  /** The Balance each Lunge gives back. */
  lungeBalance: number;
  /** The seconds Renewal's `renewing` lasts beyond its own. */
  renewingSeconds: number;
  /** The share of Deep mend's channel that runs. */
  deepMendChannel: number;
  /** The share of Radiance's heal that lands. */
  radianceHeal: number;
  /** The share of Ward's shield that holds. */
  wardAbsorb: number;
  /** The share of Dream-bolt's harm that lands. */
  boltHarm: number;
  /** Whether a Bind also puts `weakened` on its nightmare. */
  bindWeakens: boolean;
}

/** What a dreamer with no step of a set reached has: nothing changed. */
export const NO_SET_BONUSES: SetBonuses = {
  cleaveShare: 1,
  bracedSeconds: 0,
  lungeCooldown: 1,
  lungeBalance: 0,
  renewingSeconds: 0,
  deepMendChannel: 1,
  radianceHeal: 1,
  wardAbsorb: 1,
  boltHarm: 1,
  bindWeakens: false,
};

/** One step of a set: the pieces of it worn that reach it, the catalog key of what it does, and the bonuses it sets. */
export interface SetStep {
  pieces: number;
  textKey: string;
  sets: Partial<SetBonuses>;
}

/** Each role's set, in the order its steps are reached. Each bonus is set by one step alone. */
export const SET_BONUSES: Record<Role, readonly SetStep[]> = {
  fighter: [
    { pieces: 2, textKey: 'Cleave strikes each nightmare a fifth harder.', sets: { cleaveShare: 1.2 } },
    { pieces: 4, textKey: 'Brace lasts 2 s longer.', sets: { bracedSeconds: 2 } },
    { pieces: 6, textKey: "Lunge's cooldown is a third shorter, and each Lunge gives back 10 Balance.", sets: { lungeCooldown: 2 / 3, lungeBalance: 10 } },
  ],
  healer: [
    { pieces: 2, textKey: 'Renewal lasts 4 s longer.', sets: { renewingSeconds: 4 } },
    { pieces: 4, textKey: "Deep mend's channel is a third shorter.", sets: { deepMendChannel: 2 / 3 } },
    { pieces: 6, textKey: 'Radiance heals a third more.', sets: { radianceHeal: 4 / 3 } },
  ],
  mystic: [
    { pieces: 2, textKey: 'Ward holds a quarter more.', sets: { wardAbsorb: 1.25 } },
    { pieces: 4, textKey: 'Dream-bolt harms a fifth more.', sets: { boltHarm: 1.2 } },
    { pieces: 6, textKey: 'Bind also Weakens its nightmare.', sets: { bindWeakens: true } },
  ],
};

/** The pieces a set's title counts to, its last step's, though up to one in each armour and jewellery slot can be worn. */
const SET_SIZE = 6;

/** The catalog key of each role's set's title, its one placeholder the pieces worn. */
export const SET_TITLE_KEYS: Record<Role, string> = {
  fighter: "Fighters' set (%1$@/6)",
  healer: "Healers' set (%1$@/6)",
  mystic: "Mystics' set (%1$@/6)",
};

/** How many worn pieces are of the line's set, up to one in each armour and jewellery slot; none for no line, so neutral items never count. */
export function setPieces(equipment: Equipment, line: Role | undefined): number {
  if (line === undefined) return 0;
  return Object.values(equipment).filter((item) => item?.line === line).length;
}

/** How many pieces of the line's set its title counts as worn: those worn, up to `SET_SIZE`, so nine read as 6/6. */
export function shownSetPieces(equipment: Equipment, line: Role | undefined): number {
  return Math.min(SET_SIZE, setPieces(equipment, line));
}

/** The bonuses of every step of the role's set that the pieces of it worn reach; none for a dreamer with no role. */
export function setBonusesOf(equipment: Equipment, role: Role | undefined): SetBonuses {
  if (role === undefined) return NO_SET_BONUSES;
  const pieces = setPieces(equipment, role);
  return SET_BONUSES[role].reduce<SetBonuses>((bonuses, step) => (pieces >= step.pieces ? { ...bonuses, ...step.sets } : bonuses), NO_SET_BONUSES);
}
