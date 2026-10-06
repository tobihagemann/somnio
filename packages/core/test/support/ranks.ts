import type { TeachingId, TeachingRank } from '../../src/lucidity.ts';

/** The ranks a dreamer holds, by teaching, each with no practice toward the next. */
export function ranks(held: Partial<Record<TeachingId, number>>): TeachingRank[] {
  return Object.entries(held).map(([teachingId, rank]) => ({ teachingId: teachingId as TeachingId, rank, practice: 0 }));
}
