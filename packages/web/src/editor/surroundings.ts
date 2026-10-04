import { OUTDOOR_SPACE_ID, WorldError, buildSpaceCollision, buildWorld, neighbourSectors, rectsOverlap, sectorRect } from '@somnio/core';
import type { ModelRegistry, Sector, WorldIssue } from '@somnio/core';

/**
 * The document among the other sectors the file API holds: which of them border it, and what the
 * server would report about it at boot.
 */

/** The other outdoor sectors whose ground touches an outdoor document's. One that overlaps it is a mistake to report, not a neighbour to draw. */
export function neighbours(document: Sector, others: readonly Sector[]): Sector[] {
  if (document.kind !== 'outdoor') return [];
  const outdoor = others.filter((other) => other.kind === 'outdoor' && other.name !== document.name);
  return neighbourSectors({ id: OUTDOOR_SPACE_ID, sectors: [document, ...outdoor] }, document.name).filter(
    (neighbour) => !rectsOverlap(sectorRect(neighbour), sectorRect(document)),
  );
}

export interface DocumentIssues {
  /** Why the world would not load at all with this document in it. */
  error: string | undefined;
  /** What the world would report about the document's own records, each of which the overlay draws in red. */
  records: WorldIssue[];
}

/**
 * Builds the world the server would from the document and the other sectors. A world that
 * cannot be built reports why, and the document's collision issues are then read from its own
 * space.
 */
export function documentIssues(document: Sector, others: readonly Sector[], registry: ModelRegistry): DocumentIssues {
  const sectors = [document, ...others.filter((other) => other.name !== document.name)];
  // A door with no target sector yet is reported as that, not as a missing door in a sector with no name.
  const untargeted = (issue: WorldIssue): boolean =>
    issue.record === 'door' && document.doors.some((door) => door.id === issue.id && door.target.sector === '');
  const own = (issues: readonly WorldIssue[]): WorldIssue[] =>
    issues.filter((issue) => issue.sector === document.name).map((issue) => (untargeted(issue) ? { ...issue, message: 'has no target sector' } : issue));
  try {
    return { error: undefined, records: own(buildWorld(sectors, registry).issues) };
  } catch (error) {
    if (!(error instanceof WorldError)) throw error;
    return {
      error: error.message,
      records: own(buildSpaceCollision({ id: document.name, sectors: [document, ...neighbours(document, others)] }, registry).issues),
    };
  }
}

export function issueMessages(issues: DocumentIssues): string[] {
  return [...(issues.error === undefined ? [] : [issues.error]), ...issues.records.map((issue) => `${issue.record} "${issue.id}": ${issue.message}`)];
}
