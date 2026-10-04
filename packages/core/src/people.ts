/** The peoples a character can belong to. */
export const PEOPLES = ['wachen', 'soporen', 'umbren', 'lumina'] as const;
export type People = (typeof PEOPLES)[number];

const LABEL_KEYS: Record<People, string> = { wachen: 'Wachen', soporen: 'Soporen', umbren: 'Umbren', lumina: 'Lumina' };

/** The catalog key of a people's display name, which the consumer resolves in its locale. */
export function peopleLabelKey(people: People): string {
  return LABEL_KEYS[people];
}
