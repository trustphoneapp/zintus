import { LocalArtifactStore, type EngineerSupervisor } from "@zintus/engineer";

type ArtifactReadAuthoritySupervisor = Pick<EngineerSupervisor, "configureArtifactReadAuthority">;

/**
 * Construct and bind the exact-byte artifact authority as one startup action.
 * The store is not exposed to callers until the Supervisor has accepted it.
 */
export function createBoundEngineerArtifactStore(
  supervisor: ArtifactReadAuthoritySupervisor,
  root: string,
): LocalArtifactStore {
  const store = new LocalArtifactStore({ root });
  supervisor.configureArtifactReadAuthority(store);
  return store;
}
