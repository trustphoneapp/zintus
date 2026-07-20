/**
 * R7-2 refresh-hydration loader for the Approval & publication screen.
 *
 * FINDING #3 (release blocker): the publication page used to store the active
 * approval + publication ONLY in React state, and on load/refresh it reloaded
 * the CANDIDATE list — so a browser refresh mid-publication silently LOST the
 * in-flight publication and browser state was acting as the authority.
 *
 * This loader restores the authority to the server: it reads the run's durable
 * CURRENT publication projection (`getCurrentPublication`) alongside the
 * candidate list, so the page can rehydrate the exact publication + approval +
 * selected candidate from the server on every load. `current` is null when the
 * run has no active publication (or is unknown / cross-owner — the server
 * returns the same none-shape), in which case the page falls back to the
 * candidate-selection flow exactly as before.
 */

import {
  getCurrentPublication,
  getPublicationCandidates,
  type CurrentPublication,
  type PublicationCandidate,
} from "./engineer-resolution";

export interface PublicationDeskHydration {
  /** Eligible publication candidates — the selection flow when there is no active publication. */
  candidates: PublicationCandidate[];
  /** The run's durable CURRENT publication, or null when none is active. Server-derived authority. */
  current: CurrentPublication | null;
}

/**
 * Loads the durable state the Approval & publication screen restores on
 * load/refresh: the candidate list AND the run's current durable publication
 * projection. Both are read from the server so React state is never the
 * authority for an in-flight publication.
 */
export async function hydratePublicationDesk(runId: string): Promise<PublicationDeskHydration> {
  const [candidates, current] = await Promise.all([
    getPublicationCandidates(runId),
    getCurrentPublication(runId),
  ]);
  return { candidates, current };
}
