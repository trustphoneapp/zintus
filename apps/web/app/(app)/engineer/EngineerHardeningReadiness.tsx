export type EngineerHardeningReadinessState="READY"|"DEGRADED"|"UNKNOWN";

export const HARDENING_DEGRADED_COPY=
  "Optional hardening is temporarily unavailable. Restore the local prompt-cache authority, run bun run doctor:engineer, then restart the gateway. Existing runs and history remain available.";

export function HardeningReadinessBanner({state}:{state:EngineerHardeningReadinessState}){
  if(state==="READY")return null;
  return <section className="engineer-hardening-readiness" role="status" aria-live="polite"
    data-hardening-mutations-disabled="true">
    <div><strong>Optional hardening paused</strong><p>{HARDENING_DEGRADED_COPY}</p></div>
    <span className="engineer-chip">{state==="UNKNOWN"?"Readiness unavailable":"Fail-safe mode"}</span>
  </section>;
}
