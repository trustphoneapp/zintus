import { describe, expect, test } from "bun:test";
import { DatabaseIntegrityFatalMarkerConflictError,
  type EngineerSupervisor, type EngineerWorkerLeaseManager } from "@zintus/engineer";
import { recoverHardeningPaidCallsOnce, recoverOptionalHardeningAfterPaidReconciliation } from "./hardening-recovery.js";

function leaseManager(input?:{releaseFailureRun?:string}){
  const acquired:string[]=[],released:string[]=[];
  const manager={
    acquire:({resourceKey}:{resourceKey:string})=>{
      acquired.push(resourceKey);
      return {lease:{leaseId:`lease-${resourceKey}`,ownerId:"gateway-recovery",resourceKey,
        fencingToken:1,status:"ACTIVE"},leaseToken:`token-${resourceKey}`};
    },
    release:({leaseId}:{leaseId:string})=>{
      released.push(leaseId);
      if(leaseId===`lease-run:${input?.releaseFailureRun}`)throw Object.assign(new Error("secret path must not escape"),{code:"LEASE_RELEASE_FAILED"});
      return {released:true};
    },
  } as unknown as EngineerWorkerLeaseManager;
  return {manager,acquired,released};
}

describe("hardening paid-call gateway recovery",()=>{
  test("one provider-free coordinator routes cold QUEUED through signed start and later stages through signed verification",async()=>{
    const states=new Map<string,{state:string;terminalAt:string|null}>([
      ["queued-cold",{state:"QUEUED",terminalAt:null}],["queued-authorized",{state:"QUEUED",terminalAt:null}],
      ["verify",{state:"SECURITY_REVIEW",terminalAt:null}],["human",{state:"HUMAN_REVIEW_REQUIRED",terminalAt:null}],
      ["cancelling",{state:"CANCELLATION_PENDING",terminalAt:null}],["terminal",{state:"FAILED",terminalAt:"2026-07-18T12:00:00.000Z"}],
    ]);
    const calls:string[]=[];let providerCalls=0;const errors=new Map<string,string>();
    const routes=recoverOptionalHardeningAfterPaidReconciliation({
      runIds:["queued-cold","queued-authorized","verify","human","cancelling","terminal","verify"],
      supervisor:{getRun:(runId:string)=>({runId,...states.get(runId)!}),
        setLastError:(runId:string,message:string)=>{errors.set(runId,message);}} as never,
      runs:{
        recoverOptionalHardeningStarts:(runIds=[])=>{const runId=runIds[0]!;calls.push(`start:${runId}`);
          return runId==="queued-cold"?[{runId,promise:Promise.resolve("seeded")}]:[];},
        recoverOptionalHardeningVerification:(runIds=[])=>{const runId=runIds[0]!;calls.push(`verify:${runId}`);
          return [{runId,promise:Promise.resolve("verified")}];},
      },
      execution:{hasOptionalHardeningAuthority:(runId:string)=>runId==="queued-authorized",
        resumeRecovered:(runId:string)=>{calls.push(`execute:${runId}`);}},
    });
    await Promise.all(routes.map((item)=>item.promise));
    expect(routes.map((item)=>[item.runId,item.route])).toEqual([
      ["queued-cold","SIGNED_START"],["queued-authorized","AUTHORIZED_EXECUTION"],["verify","SIGNED_VERIFICATION"],
    ]);
    expect(calls).toEqual(["start:queued-cold","start:queued-authorized","execute:queued-authorized","verify:verify"]);
    expect(errors.size).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("a QUEUED child without reconstructed signed authority stays paused and never reports execution",()=>{
    const calls:string[]=[],errors=new Map<string,string>();
    const routes=recoverOptionalHardeningAfterPaidReconciliation({runIds:["missing-authority"],
      supervisor:{getRun:()=>({runId:"missing-authority",state:"QUEUED",terminalAt:null}),
        setLastError:(runId:string,message:string)=>{errors.set(runId,message);}} as never,
      runs:{recoverOptionalHardeningStarts:()=>[],recoverOptionalHardeningVerification:()=>[]},
      execution:{hasOptionalHardeningAuthority:()=>false,resumeRecovered:(runId:string)=>{calls.push(runId);}}});
    expect(routes).toEqual([]);expect(calls).toEqual([]);
    expect(errors.get("missing-authority")).toStartWith("HARDENING_SIGNED_START_AUTHORITY_UNAVAILABLE:");
  });

  test("isolates malformed, idle, live-fenced, corrupt, and release-failed runs without starving healthy work",()=>{
    const runIds=["ordinary","malformed","idle","live-fence","corrupt","release-fail","healthy"];
    const lastErrors=new Map<string,string|null>();
    const marked=new Set<string>();
    const lifecycleCalls:string[]=[];
    const markerCalls:string[]=[];
    const supervisor={
      listRuns:()=>runIds.map((runId)=>({runId})),
      isOptionalHardeningChild:(runId:string)=>{
        if(runId==="malformed")throw Object.assign(new Error("hostile malformed lineage /private/tmp/db"),{code:"MALFORMED_LINEAGE"});
        return runId!=="ordinary";
      },
      getExactHardeningDatabaseIntegrityFatal:(runId:string)=>marked.has(runId)?{reasonCode:"DATABASE_INTEGRITY_CORRUPTION"}:null,
      recordOrReplayHardeningDatabaseIntegrityFatal:(runId:string)=>{markerCalls.push(runId);marked.add(runId);return {status:"APPLIED"};},
      hasOutstandingHardeningPaidCallRecoveryWork:(runId:string)=>runId!=="idle",
      hardeningPaidCallRecoveryReady:(runId:string)=>runId!=="live-fence",
      recoverHardeningPaidCallLifecycle:({childRunId}:{childRunId:string})=>{
        lifecycleCalls.push(childRunId);
        if(childRunId==="corrupt")throw Object.assign(new Error("raw database row"),{
          code:"DATABASE_INTEGRITY_CORRUPTION",childRunId,reservationId:"reservation-corrupt",retryable:false});
        return childRunId==="healthy"?
          {recoveredReservations:1,appliedFinalizations:0,terminalizedPreReservationAgent:false}:
          {recoveredReservations:0,appliedFinalizations:0,terminalizedPreReservationAgent:false};
      },
      getLastError:(runId:string)=>lastErrors.get(runId)??null,
      setLastError:(runId:string,value:string|null)=>{lastErrors.set(runId,value);},
    } as unknown as EngineerSupervisor;
    const leases=leaseManager({releaseFailureRun:"release-fail"});
    const result=recoverHardeningPaidCallsOnce({supervisor,workerLeases:leases.manager,
      workerLeaseSecret:"gateway-recovery-test-secret-000000000000",ownerId:"gateway-recovery",
      nowMs:Date.parse("2026-07-18T12:00:00.000Z"),idFactory:(()=>{let id=0;return()=>`id-${++id}`;})()});

    expect(result.recovered).toEqual([{runId:"healthy",recoveredReservations:1,
      appliedFinalizations:0,terminalizedPreReservationAgent:false}]);
    expect(result.errors.map(({runId,stage,code})=>({runId,stage,code}))).toEqual([
      {runId:"malformed",stage:"PROBE",code:"MALFORMED_LINEAGE"},
      {runId:"corrupt",stage:"RECOVERY",code:"DATABASE_INTEGRITY_CORRUPTION"},
      {runId:"release-fail",stage:"RELEASE",code:"LEASE_RELEASE_FAILED"},
    ]);
    expect(JSON.stringify(result)).not.toContain("/private/tmp");
    expect(markerCalls).toEqual(["corrupt"]);
    expect(lifecycleCalls).toEqual(["corrupt","release-fail","healthy"]);
    expect(leases.acquired).toEqual(["run:corrupt","run:release-fail","run:healthy"]);
    expect(leases.released).toEqual(["lease-run:corrupt","lease-run:release-fail","lease-run:healthy"]);
    expect(lastErrors.get("malformed")).toBeUndefined();
  });

  test("exact fatal markers and marker conflicts remain terminal while later runs recover",()=>{
    const lifecycle:string[]=[],markerCalls:string[]=[];
    const supervisor={
      listRuns:()=>["exact","conflict","healthy"].map((runId)=>({runId})),
      isOptionalHardeningChild:()=>true,
      getExactHardeningDatabaseIntegrityFatal:(runId:string)=>{
        if(runId==="exact")return {reasonCode:"DATABASE_INTEGRITY_CORRUPTION"};
        if(runId==="conflict")throw new DatabaseIntegrityFatalMarkerConflictError(runId);
        return null;
      },
      recordOrReplayHardeningDatabaseIntegrityFatal:(runId:string)=>{
        markerCalls.push(runId);
        if(runId==="conflict")throw new DatabaseIntegrityFatalMarkerConflictError(runId);
        return {status:"REPLAYED"};
      },
      hasOutstandingHardeningPaidCallRecoveryWork:()=>true,
      hardeningPaidCallRecoveryReady:()=>true,
      recoverHardeningPaidCallLifecycle:({childRunId}:{childRunId:string})=>{
        lifecycle.push(childRunId);return {recoveredReservations:1,appliedFinalizations:0,terminalizedPreReservationAgent:false};
      },
      getLastError:()=>null,
      setLastError:()=>undefined,
    } as unknown as EngineerSupervisor;
    const leases=leaseManager();
    const result=recoverHardeningPaidCallsOnce({supervisor,workerLeases:leases.manager,
      workerLeaseSecret:"gateway-recovery-test-secret-000000000000",ownerId:"gateway-recovery",nowMs:1});
    expect(result.recovered.map((item)=>item.runId)).toEqual(["healthy"]);
    expect(result.errors.map((item)=>[item.runId,item.stage,item.code])).toEqual([
      ["conflict","MARKER","DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT"],
    ]);
    expect(markerCalls).toEqual(["exact","conflict"]);
    expect(lifecycle).toEqual(["healthy"]);
    expect(leases.acquired).toEqual(["run:healthy"]);
  });

  test("prompt authority failures never create database-corruption markers",()=>{
    const markerCalls:string[]=[],lastErrors:string[]=[];
    const supervisor={
      listRuns:()=>[{runId:"authority"},{runId:"healthy"}],isOptionalHardeningChild:()=>true,
      getExactHardeningDatabaseIntegrityFatal:()=>null,
      hasOutstandingHardeningPaidCallRecoveryWork:(runId:string)=>{
        if(runId==="authority")throw Object.assign(new Error("do not expose secret"),{code:"HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH"});
        return true;
      },
      hardeningPaidCallRecoveryReady:()=>true,
      recoverHardeningPaidCallLifecycle:()=>({recoveredReservations:1,appliedFinalizations:0,terminalizedPreReservationAgent:false}),
      recordOrReplayHardeningDatabaseIntegrityFatal:(runId:string)=>{markerCalls.push(runId);},
      getLastError:()=>null,setLastError:(_runId:string,message:string)=>{lastErrors.push(message);},
    } as unknown as EngineerSupervisor;
    const leases=leaseManager();
    const result=recoverHardeningPaidCallsOnce({supervisor,workerLeases:leases.manager,
      workerLeaseSecret:"gateway-recovery-test-secret-000000000000",ownerId:"gateway-recovery",nowMs:1});
    expect(markerCalls).toEqual([]);
    expect(result.recovered.map((item)=>item.runId)).toEqual(["healthy"]);
    expect(result.errors.map((item)=>item.code)).toEqual(["HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH"]);
    expect(lastErrors[0]).not.toContain("do not expose secret");
  });

  test("code-only, retryable, and wrong-run corruption lookalikes never create fatal markers",()=>{
    const runIds=["code-only","retryable","wrong-run","healthy"];
    const markerCalls:string[]=[],guidanceRuns:string[]=[],lifecycleCalls:string[]=[];
    const supervisor={
      listRuns:()=>runIds.map((runId)=>({runId})),isOptionalHardeningChild:()=>true,
      getExactHardeningDatabaseIntegrityFatal:()=>null,
      hasOutstandingHardeningPaidCallRecoveryWork:()=>true,hardeningPaidCallRecoveryReady:()=>true,
      recoverHardeningPaidCallLifecycle:({childRunId}:{childRunId:string})=>{
        lifecycleCalls.push(childRunId);
        if(childRunId==="code-only")throw Object.assign(new Error("spoof"),{code:"DATABASE_INTEGRITY_CORRUPTION"});
        if(childRunId==="retryable")throw Object.assign(new Error("spoof"),{
          code:"DATABASE_INTEGRITY_CORRUPTION",retryable:true,childRunId,reservationId:"reservation-retryable"});
        if(childRunId==="wrong-run")throw Object.assign(new Error("spoof"),{
          code:"DATABASE_INTEGRITY_CORRUPTION",retryable:false,childRunId:"different-run",reservationId:"reservation-wrong"});
        return {recoveredReservations:1,appliedFinalizations:0,terminalizedPreReservationAgent:false};
      },
      recordOrReplayHardeningDatabaseIntegrityFatal:(runId:string)=>{markerCalls.push(runId);},
      getLastError:()=>null,setLastError:(runId:string)=>{guidanceRuns.push(runId);},
    } as unknown as EngineerSupervisor;
    const leases=leaseManager();
    const result=recoverHardeningPaidCallsOnce({supervisor,workerLeases:leases.manager,
      workerLeaseSecret:"gateway-recovery-test-secret-000000000000",ownerId:"gateway-recovery",nowMs:1});

    expect(markerCalls).toEqual([]);
    expect(guidanceRuns).toEqual([]);
    expect(result.recovered.map((item)=>item.runId)).toEqual(["healthy"]);
    expect(result.errors.map((item)=>[item.runId,item.stage,item.code])).toEqual([
      ["code-only","RECOVERY","DATABASE_INTEGRITY_CORRUPTION"],
      ["retryable","RECOVERY","DATABASE_INTEGRITY_CORRUPTION"],
      ["wrong-run","RECOVERY","DATABASE_INTEGRITY_CORRUPTION"],
    ]);
    expect(lifecycleCalls).toEqual(runIds);
  });

  test("code-only structural and marker-conflict lookalikes cannot mutate durable recovery authority",()=>{
    const runIds=["budget-spoof","marker-spoof","healthy"],markerCalls:string[]=[],guidanceCalls:string[]=[],lifecycle:string[]=[];
    const supervisor={
      listRuns:()=>runIds.map((runId)=>({runId})),isOptionalHardeningChild:()=>true,
      getExactHardeningDatabaseIntegrityFatal:(runId:string)=>{
        if(runId==="marker-spoof")throw Object.assign(new Error("spoof"),{code:"DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT"});
        return null;
      },
      hasOutstandingHardeningPaidCallRecoveryWork:(runId:string)=>{
        if(runId==="budget-spoof")throw Object.assign(new Error("spoof"),{code:"HARDENING_BUDGET_AUTHORITY_INVALID"});
        return true;
      },
      hardeningPaidCallRecoveryReady:()=>true,
      recoverHardeningPaidCallLifecycle:({childRunId}:{childRunId:string})=>{lifecycle.push(childRunId);
        return {recoveredReservations:1,appliedFinalizations:0,terminalizedPreReservationAgent:false};},
      recordOrReplayHardeningDatabaseIntegrityFatal:(runId:string)=>{markerCalls.push(runId);},
      getLastError:()=>null,setLastError:(runId:string)=>{guidanceCalls.push(runId);},
    } as unknown as EngineerSupervisor;
    const leases=leaseManager();
    const result=recoverHardeningPaidCallsOnce({supervisor,workerLeases:leases.manager,
      workerLeaseSecret:"gateway-recovery-test-secret-000000000000",ownerId:"gateway-recovery",nowMs:1});

    expect(markerCalls).toEqual([]);
    expect(guidanceCalls).toEqual([]);
    expect(lifecycle).toEqual(["healthy"]);
    expect(leases.acquired).toEqual(["run:healthy"]);
    expect(result.recovered.map((item)=>item.runId)).toEqual(["healthy"]);
    expect(result.errors.map((item)=>[item.runId,item.stage,item.code])).toEqual([
      ["budget-spoof","PROBE","HARDENING_BUDGET_AUTHORITY_INVALID"],
      ["marker-spoof","PROBE","DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT"],
    ]);
  });

  test("guidance persistence failure is isolated and cannot starve a later healthy run",()=>{
    const supervisor={
      listRuns:()=>[{runId:"guidance-fails"},{runId:"healthy"}],isOptionalHardeningChild:()=>true,
      getExactHardeningDatabaseIntegrityFatal:()=>null,
      hasOutstandingHardeningPaidCallRecoveryWork:(runId:string)=>{
        if(runId==="guidance-fails")throw Object.assign(new Error("local authority detail"),{
          code:"HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE"});
        return true;
      },
      hardeningPaidCallRecoveryReady:()=>true,
      recoverHardeningPaidCallLifecycle:()=>({recoveredReservations:1,appliedFinalizations:0,
        terminalizedPreReservationAgent:false}),
      recordOrReplayHardeningDatabaseIntegrityFatal:()=>undefined,getLastError:()=>null,
      setLastError:()=>{throw Object.assign(new Error("database path"),{code:"GUIDANCE_WRITE_FAILED"});},
    } as unknown as EngineerSupervisor;
    const leases=leaseManager();
    const result=recoverHardeningPaidCallsOnce({supervisor,workerLeases:leases.manager,
      workerLeaseSecret:"gateway-recovery-test-secret-000000000000",ownerId:"gateway-recovery",nowMs:1});

    expect(result.recovered.map((item)=>item.runId)).toEqual(["healthy"]);
    expect(result.errors.map((item)=>[item.runId,item.stage,item.code])).toEqual([
      ["guidance-fails","PROBE","GUIDANCE_WRITE_FAILED"],
      ["guidance-fails","PROBE","HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE"],
    ]);
    expect(JSON.stringify(result)).not.toContain("database path");
    expect(JSON.stringify(result)).not.toContain("local authority detail");
  });

  test("restored authority clears only exact stale prompt guidance with compare-and-set semantics",()=>{
    const unavailable="HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE: Optional hardening recovery is paused. Restore the original local prompt-cache authority, run `bun run doctor:engineer`, then restart the gateway.";
    const mismatch="HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH: Optional hardening recovery is paused because the local prompt-cache authority does not match durable reservations. Restore the original authority, run `bun run doctor:engineer`, then restart the gateway.";
    const lastErrors=new Map<string,string|null>([["exact",unavailable],["raced",mismatch],["unrelated","do not clear me"]]);
    const clearCalls:Array<[string,string]>=[];
    const supervisor={
      listRuns:()=>["exact","raced","unrelated"].map((runId)=>({runId})),isOptionalHardeningChild:()=>true,
      getLastError:(runId:string)=>lastErrors.get(runId)??null,
      clearLastErrorIfExact:(runId:string,expected:string)=>{
        clearCalls.push([runId,expected]);
        if(runId==="raced")lastErrors.set(runId,"new concurrent failure");
        if(lastErrors.get(runId)!==expected)return false;
        lastErrors.set(runId,null);return true;
      },
      getExactHardeningDatabaseIntegrityFatal:()=>null,
      hasOutstandingHardeningPaidCallRecoveryWork:()=>false,
      hardeningPaidCallRecoveryReady:()=>false,
      recoverHardeningPaidCallLifecycle:()=>{throw new Error("must not run");},
      recordOrReplayHardeningDatabaseIntegrityFatal:()=>undefined,setLastError:()=>undefined,
    } as unknown as EngineerSupervisor;
    const leases=leaseManager();
    const result=recoverHardeningPaidCallsOnce({supervisor,workerLeases:leases.manager,
      workerLeaseSecret:"gateway-recovery-test-secret-000000000000",ownerId:"gateway-recovery",nowMs:1});

    expect(result).toEqual({recovered:[],errors:[]});
    expect(clearCalls).toEqual([["exact",unavailable],["raced",mismatch]]);
    expect(lastErrors.get("exact")).toBeNull();
    expect(lastErrors.get("raced")).toBe("new concurrent failure");
    expect(lastErrors.get("unrelated")).toBe("do not clear me");
    expect(leases.acquired).toEqual([]);
  });
});
