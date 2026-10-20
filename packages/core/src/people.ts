/** The peoples a character can belong to. */
export const PEOPLES = ['vigils', 'sopors', 'umbrae', 'lumina'] as const;
export type People = (typeof PEOPLES)[number];

const LABEL_KEYS: Record<People, string> = { vigils: 'Vigils', sopors: 'Sopors', umbrae: 'Umbrae', lumina: 'Lumina' };

/** The catalog key of a people's display name, which the consumer resolves in its locale. */
export function peopleLabelKey(people: People): string {
  return LABEL_KEYS[people];
}
