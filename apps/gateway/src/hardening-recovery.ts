import { DatabaseIntegrityFatalMarkerConflictAuthorityInvalidError,
  DatabaseIntegrityFatalMarkerConflictError, HardeningBudgetAuthorityInvalidError,
  type EngineerSupervisor, type EngineerWorkerLeaseManager } from "@zintus/engineer";
import { createHmac, randomUUID } from "node:crypto";

export {
  HARDENING_DATABASE_INTEGRITY_GUIDANCE,
  hardeningDatabaseIntegrityFailureId,
} from "@zintus/engineer";

export interface HardeningPaidCallRecoveryRecord {
  runId: string;
  recoveredReservations: number;
  appliedFinalizations: number;
  terminalizedPreReservationAgent: boolean;
}

export interface HardeningPaidCallRecoveryError {
  runId: string;
  stage: "PROBE" | "RECOVERY" | "MARKER" | "RELEASE";
  code: string;
  message: string;
}

export interface HardeningPaidCallRecoverySweepResult {
  recovered: HardeningPaidCallRecoveryRecord[];
  errors: HardeningPaidCallRecoveryError[];
}

export interface OptionalHardeningRecoveryRoute {
  runId:string;
  route:"SIGNED_START"|"AUTHORIZED_EXECUTION"|"SIGNED_VERIFICATION";
  promise:Promise<unknown>;
}

/**
 * One provider-free post-reconciliation coordinator shared by boot, the paid
 * recovery timer, and the worker-lease watchdog. A cold QUEUED child must
 * reconstruct its signed start/seed authority before execution; later stages
 * use only the dedicated signed verification snapshot lane.
 */
export function recoverOptionalHardeningAfterPaidReconciliation(input:{
  runIds:readonly string[];
  supervisor:Pick<EngineerSupervisor,"getRun"|"setLastError">;
  runs:{
    recoverOptionalHardeningStarts:(runIds?:readonly string[])=>Array<{runId:string;promise:Promise<unknown>}>;
    recoverOptionalHardeningVerification:(runIds?:readonly string[])=>Array<{runId:string;promise:Promise<unknown>}>;
  };
  execution:{resumeRecovered:(runId:string)=>void;hasOptionalHardeningAuthority:(runId:string)=>boolean}|undefined;
}):OptionalHardeningRecoveryRoute[]{
  const routes:OptionalHardeningRecoveryRoute[]=[];
  for(const runId of [...new Set(input.runIds)]){
    const run=input.supervisor.getRun(runId);
    if(run.terminalAt||run.state==="CANCELLATION_PENDING"||run.state==="HUMAN_REVIEW_REQUIRED")continue;
    if(run.state==="QUEUED"){
      const starts=input.runs.recoverOptionalHardeningStarts([runId]);
      if(starts.length>0){
        routes.push(...starts.map((item)=>({runId:item.runId,route:"SIGNED_START" as const,promise:item.promise})));
      }else if(input.execution?.hasOptionalHardeningAuthority(runId)){
        input.execution.resumeRecovered(runId);
        routes.push({runId,route:"AUTHORIZED_EXECUTION",promise:Promise.resolve()});
      }else{
        input.supervisor.setLastError(runId,
          "HARDENING_SIGNED_START_AUTHORITY_UNAVAILABLE: Recovery paused before execution because the exact signed start authority could not be reconstructed. Restart the gateway after restoring the original local authority; no provider call was made.");
      }
      continue;
    }
    routes.push(...input.runs.recoverOptionalHardeningVerification([runId])
      .map((item)=>({runId:item.runId,route:"SIGNED_VERIFICATION" as const,promise:item.promise})));
  }
  return routes;
}

const RECOVERY_PAUSED_GUIDANCE =
  "HARDENING_RECOVERY_PAUSED: Optional hardening recovery stopped safely before any provider call. Resolve the reported local authority or recovery condition, run `bun run doctor:engineer`, then restart the gateway.";
const PROMPT_AUTHORITY_UNAVAILABLE_GUIDANCE =
  "HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE: Optional hardening recovery is paused. Restore the original local prompt-cache authority, run `bun run doctor:engineer`, then restart the gateway.";
const PROMPT_AUTHORITY_MISMATCH_GUIDANCE =
  "HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH: Optional hardening recovery is paused because the local prompt-cache authority does not match durable reservations. Restore the original authority, run `bun run doctor:engineer`, then restart the gateway.";

function errorCode(error:unknown):string{
  if(typeof error==="object"&&error!==null&&typeof (error as {code?:unknown}).code==="string")
    return (error as {code:string}).code;
  return error instanceof Error&&error.name?error.name:"UNKNOWN_RECOVERY_ERROR";
}

function isDatabaseIntegrityCorruption(error:unknown,runId:string):boolean{
  if(typeof error!=="object"||error===null)return false;
  const value=error as {code?:unknown;retryable?:unknown;childRunId?:unknown;reservationId?:unknown};
  return value.code==="DATABASE_INTEGRITY_CORRUPTION"&&value.retryable===false&&value.childRunId===runId&&
    typeof value.reservationId==="string"&&value.reservationId.length>0;
}

function isStructuralHardeningAuthorityFailure(error:unknown):boolean{
  return error instanceof HardeningBudgetAuthorityInvalidError;
}

function isPromptAuthorityFailure(error:unknown):boolean{
  return ["HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE","HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH"]
    .includes(errorCode(error));
}

function isMarkerConflict(error:unknown):boolean{
  return error instanceof DatabaseIntegrityFatalMarkerConflictError||
    error instanceof DatabaseIntegrityFatalMarkerConflictAuthorityInvalidError;
}

function isUntrustedFatalLookalike(error:unknown):boolean{
  return ["DATABASE_INTEGRITY_CORRUPTION","HARDENING_BUDGET_AUTHORITY_INVALID",
    "DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT","DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT_AUTHORITY_INVALID"]
    .includes(errorCode(error));
}

function writeGuidance(input:{supervisor:EngineerSupervisor;runId:string;message:string;
  stage:"PROBE"|"RECOVERY";errors:HardeningPaidCallRecoveryError[]}):void{
  try{
    if(input.supervisor.getLastError(input.runId)!==input.message)
      input.supervisor.setLastError(input.runId,input.message);
  }catch(error){
    input.errors.push({runId:input.runId,stage:input.stage,code:errorCode(error),
      message:"Recovery guidance could not be persisted; later runs were still inspected."});
  }
}

/**
 * Provider-free, per-run-isolated recovery. Every probe precedes lease
 * acquisition, the Supervisor repeats the predicate transactionally after the
 * worker lease, and one malformed run can never starve later runs.
 */
export function recoverHardeningPaidCallsOnce(input: {
  supervisor: EngineerSupervisor;
  workerLeases: EngineerWorkerLeaseManager;
  workerLeaseSecret: string;
  ownerId?: string;
  nowMs?: number;
  idFactory?: () => string;
}):HardeningPaidCallRecoverySweepResult {
  const ownerId=input.ownerId??`gateway:${process.pid}:hardening-paid-call-recovery`;
  const nowMs=input.nowMs??Date.now();
  const idFactory=input.idFactory??randomUUID;
  const recovered:HardeningPaidCallRecoveryRecord[]=[];
  const errors:HardeningPaidCallRecoveryError[]=[];
  for(const run of input.supervisor.listRuns()){
    let recoveryLease:ReturnType<EngineerWorkerLeaseManager["acquire"]>|null=null;
    let classifiedOptional=false;
    try{
      // Keep classification inside the isolation boundary: malformed lineage
      // for one run is reported without aborting the rest of the sweep.
      if(!input.supervisor.isOptionalHardeningChild(run.runId))continue;
      classifiedOptional=true;

      const priorError=input.supervisor.getLastError(run.runId);
      if(priorError===PROMPT_AUTHORITY_UNAVAILABLE_GUIDANCE||priorError===PROMPT_AUTHORITY_MISMATCH_GUIDANCE){
        try{input.supervisor.clearLastErrorIfExact(run.runId,priorError);}
        catch(error){errors.push({runId:run.runId,stage:"PROBE",code:errorCode(error),
          message:"Restored prompt-cache authority was detected, but stale recovery guidance could not be cleared."});}
      }

      const exactFatal=input.supervisor.getExactHardeningDatabaseIntegrityFatal(run.runId);
      if(exactFatal){
        try{input.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(run.runId);}
        catch(error){
          errors.push({runId:run.runId,stage:"MARKER",code:errorCode(error),
            message:"Durable database-integrity recovery authority remains terminal; automatic recovery stayed disabled."});
        }
        continue;
      }

      if(!input.supervisor.hasOutstandingHardeningPaidCallRecoveryWork(run.runId))continue;
      // A live paid-call fence or otherwise non-recoverable outstanding item is
      // deliberately zero-work. The lifecycle repeats this test under lock.
      if(!input.supervisor.hardeningPaidCallRecoveryReady(run.runId,nowMs))continue;

      recoveryLease=input.workerLeases.acquire({resourceKey:`run:${run.runId}`,ownerId,ttlMs:30_000,
        idempotencyKey:`hardening-recovery:${idFactory()}`});
      const rawToken=createHmac("sha256",input.workerLeaseSecret)
        .update(`engineer-hardening-paid-call-recovery-v1:${run.runId}`).digest("base64url");
      const result=input.supervisor.recoverHardeningPaidCallLifecycle({childRunId:run.runId,ownerId,rawToken,nowMs,
        recoveryWorkerLease:{leaseId:recoveryLease.lease.leaseId,ownerId,fencingToken:recoveryLease.lease.fencingToken,
          leaseToken:recoveryLease.leaseToken}});
      if(result.recoveredReservations>0||result.appliedFinalizations>0||result.terminalizedPreReservationAgent)
        recovered.push({runId:run.runId,...result});
    }catch(error){
      const code=errorCode(error);
      if(error instanceof Error&&["WorkerLeaseConflictError","WorkerLeaseCapacityError"].includes(error.name))continue;
      if(isDatabaseIntegrityCorruption(error,run.runId)||isStructuralHardeningAuthorityFailure(error)||isMarkerConflict(error)){
        try{
          input.supervisor.recordOrReplayHardeningDatabaseIntegrityFatal(run.runId);
        }catch(markerError){
          const markerCode=errorCode(markerError);
          errors.push({runId:run.runId,stage:"MARKER",code:markerCode,
            message:"Database-integrity recovery authority conflicted; automatic recovery stayed disabled."});
        }
        if(!isMarkerConflict(error))
          errors.push({runId:run.runId,stage:"RECOVERY",code,
            message:"Durable paid-call authority failed integrity verification; automatic recovery stayed disabled."});
        continue;
      }
      // Error codes are transport text, not authority. A plain object that
      // imitates a fatal code must not create a marker or persist guidance.
      if(isUntrustedFatalLookalike(error)){
        errors.push({runId:run.runId,stage:recoveryLease?"RECOVERY":"PROBE",code,
          message:"Untrusted recovery error metadata was isolated; no durable fatal authority was created."});
        continue;
      }
      if(isPromptAuthorityFailure(error)){
        const stage=recoveryLease?"RECOVERY":"PROBE";
        writeGuidance({supervisor:input.supervisor,runId:run.runId,
          message:code==="HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH"?
            PROMPT_AUTHORITY_MISMATCH_GUIDANCE:PROMPT_AUTHORITY_UNAVAILABLE_GUIDANCE,stage,errors});
        errors.push({runId:run.runId,stage,code,
          message:"Prompt-cache authority is unavailable or mismatched; optional hardening stayed paused."});
        continue;
      }
      if(classifiedOptional)writeGuidance({supervisor:input.supervisor,runId:run.runId,message:RECOVERY_PAUSED_GUIDANCE,
        stage:recoveryLease?"RECOVERY":"PROBE",errors});
      errors.push({runId:run.runId,stage:recoveryLease?"RECOVERY":"PROBE",code,
        message:"Optional hardening recovery stopped safely before any provider call; later runs were still inspected."});
    }finally{
      if(recoveryLease){
        try{input.workerLeases.release({leaseId:recoveryLease.lease.leaseId,ownerId,
          fencingToken:recoveryLease.lease.fencingToken,leaseToken:recoveryLease.leaseToken,
          idempotencyKey:"hardening-recovery-release"});}
        catch(error){
          errors.push({runId:run.runId,stage:"RELEASE",code:errorCode(error),
            message:"Recovery lease release failed; its fencing expiry remains authoritative."});
        }
      }
    }
  }
  return {recovered,errors};
}
