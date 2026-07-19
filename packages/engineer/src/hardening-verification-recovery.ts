import { z } from "zod";
import { ArtifactRecordSchema, type ArtifactRecord } from "./execution-contracts.js";
import { ReviewerInputSchema, TrustedEvidenceSchema, type RunStateEvent, type TrustedEvidence } from "./contracts.js";
import { compareCodeUnits, sha256 } from "./hash.js";
import { SecurityFindingRecordSchema, VerificationExecutionRecordSchema } from "./verification-contracts.js";
import { IsolatedReviewerRequestAuthoritySchema } from "./isolated-reviewer.js";

const HashSchema=z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * Storage-independent artifact identity used by every signed optional-
 * hardening authority. `storageReference` is deliberately excluded: it is a
 * local retrieval detail, not durable evidence identity, and including it
 * would leak repository roots and fork hashes when an artifact is restored on
 * another machine. Callers must resolve this projection to one live ledger
 * record and strict-read that record before trusting it.
 */
export const HardeningArtifactAuthoritySchema=z.object({
  artifactId:z.string().min(1).max(200),runId:z.string().min(1).max(200),type:z.string().min(1).max(100),
  sha256:HashSchema,producerType:z.enum(["EXECUTOR","SYSTEM"]),producerId:z.string().min(1).max(200),
  sizeBytes:z.number().int().nonnegative(),trusted:z.boolean(),createdAt:z.string().datetime({offset:true}),
}).strict();
export type HardeningArtifactAuthority=z.infer<typeof HardeningArtifactAuthoritySchema>;

export function projectHardeningArtifactAuthority(artifact:ArtifactRecord):HardeningArtifactAuthority{
  const parsed=ArtifactRecordSchema.parse(artifact);
  return HardeningArtifactAuthoritySchema.parse({artifactId:parsed.artifactId,runId:parsed.runId,type:parsed.type,
    sha256:parsed.sha256,producerType:parsed.producerType,producerId:parsed.producerId,sizeBytes:parsed.sizeBytes,
    trusted:parsed.trusted,createdAt:parsed.createdAt});
}

export function resolveHardeningArtifactAuthority(input:{authority:HardeningArtifactAuthority;
  artifacts:readonly ArtifactRecord[];readArtifact:(artifact:ArtifactRecord)=>Uint8Array}):ArtifactRecord{
  const authority=HardeningArtifactAuthoritySchema.parse(input.authority),matches=input.artifacts.filter((artifact)=>
    sha256(projectHardeningArtifactAuthority(artifact))===sha256(authority));
  if(matches.length!==1)throw new Error(`hardening artifact ${authority.artifactId} authority is not exact`);
  input.readArtifact(matches[0]!);
  return matches[0]!;
}

function finiteEpoch(value:string,label:string):number{
  const epoch=Date.parse(value);
  if(!Number.isFinite(epoch))throw new TypeError(`${label} timestamp is invalid`);
  return epoch;
}

function nextIso(epoch:number,label:string):string{
  const next=epoch+1;
  if(!Number.isSafeInteger(next))throw new RangeError(`${label} timestamp is outside the safe range`);
  return new Date(next).toISOString();
}

/**
 * The optional-hardening Reviewer ingress clock is derived only from the
 * immutable H checkpoint graph. It never depends on a recovering worker's
 * wall clock, so a fixed or regressing clock cannot fork durable authority.
 */
export function hardeningReviewerIngressTimes(input:{headTimestamp:string;checkpointCreatedAt:string;
  checkpointEvidence:readonly TrustedEvidence[]}){
  const base=Math.max(finiteEpoch(input.headTimestamp,"checkpoint head"),
    finiteEpoch(input.checkpointCreatedAt,"checkpoint artifact"),
    ...input.checkpointEvidence.map((item)=>finiteEpoch(item.createdAt,`checkpoint evidence ${item.evidenceId}`)));
  // O and R share the immutable H-derived clock. Scope may equal R; durable
  // sequence orders the event while authority remains byte-identical H→C vs H→O→R→C.
  const openedAt=new Date(base).toISOString(),resumedAt=nextIso(base,"checkpoint resumed"),scopeAt=resumedAt,
    preReviewAt=nextIso(finiteEpoch(scopeAt,"final scope"),"PRE_REVIEW"),
    riskAt=nextIso(finiteEpoch(preReviewAt,"PRE_REVIEW"),"final risk"),
    reviewerAt=nextIso(finiteEpoch(riskAt,"final risk"),"Reviewer input"),
    completionAt=nextIso(finiteEpoch(reviewerAt,"Reviewer input"),"completion");
  return {openedAt,resumedAt,scopeAt,preReviewAt,riskAt,reviewerAt,completionAt};
}

export const hardeningFinalScopeArtifactId=(input:{runId:string;checkpointHash:string;scopePayloadHash:string})=>
  sha256({namespace:"engineer-hardening-final-scope-v1",...input});
export const hardeningPreReviewArtifactId=(input:{runId:string;checkpointHash:string;baselineHash:string;
  comparisonHash:string})=>sha256({namespace:"engineer-hardening-pre-review-v1",...input});
export const hardeningPreReviewAuditId=(input:{runId:string;checkpointHash:string;comparisonHash:string})=>
  sha256({namespace:"engineer-hardening-pre-review-audit-v1",...input});
export const hardeningFinalRiskAssessmentId=(input:{runId:string;checkpointHash:string;featuresHash:string;
  ruleVersion:string})=>sha256({namespace:"engineer-hardening-final-risk-v1",...input});
export const hardeningFinalRiskAuditId=(input:{runId:string;checkpointHash:string;assessmentId:string})=>
  sha256({namespace:"engineer-hardening-final-risk-audit-v1",...input});
export const hardeningReviewAuthorityArtifactId=(input:{runId:string;checkpointHash:string;authorityHash:string})=>
  sha256({namespace:"engineer-hardening-review-authority-v1",...input});
export const IndependentVerificationOutputSchema=z.object({executions:z.array(VerificationExecutionRecordSchema),
  securityFindings:z.array(SecurityFindingRecordSchema),trustedEvidence:z.array(TrustedEvidenceSchema),
  securityReportArtifact:HardeningArtifactAuthoritySchema}).strict();

export const OptionalHardeningIndependentCheckpointSchema=z.object({
  version:z.literal(2),runId:z.string().min(1),manifestHash:HashSchema,diffHash:HashSchema,
  resultCommitSha:z.string().regex(/^[a-f0-9]{40,64}$/i),diffArtifactId:z.string().min(1),diffArtifactHash:HashSchema,
  selectedEventId:z.string().min(1),selectedEventSequence:z.number().int().safe().positive(),
  selectedEventStateVersion:z.number().int().safe().nonnegative(),selectedEventState:z.string().min(1),
  selectedEventReasonCode:z.string().min(1),selectedEventEvidenceHash:HashSchema,selectedEventHash:HashSchema,
  verified:IndependentVerificationOutputSchema,checkpointHash:HashSchema,
}).strict().superRefine((value,context)=>{
  const {checkpointHash,...content}=value;
  if(sha256(content)!==checkpointHash)context.addIssue({code:"custom",path:["checkpointHash"],message:"checkpoint hash mismatch"});
});

export type OptionalHardeningIndependentCheckpoint=z.infer<typeof OptionalHardeningIndependentCheckpointSchema>;

export function hardeningReviewCompletionEvidence(input:{checkpointEvidenceIds:readonly [string,string,string];
  authorityArtifactId:string;authorityArtifactHash:string;trustedEvidenceIds:readonly string[]}){
  const suffix=[input.authorityArtifactId,input.authorityArtifactHash,...input.trustedEvidenceIds].sort(),
    all=[...input.checkpointEvidenceIds,...suffix];
  if(new Set(suffix).size!==suffix.length||new Set(all).size!==all.length)
    throw new Error("hardening review completion evidence collides or repeats");
  return all;
}

const HardeningEvidenceLedgerReferenceSchema=z.object({kind:z.literal("LEDGER_ROW"),table:z.enum([
  "test_executions","command_executions"]),rowId:z.string().min(1),rowHash:HashSchema}).strict();
const HardeningEvidenceArtifactReferenceSchema=z.object({kind:z.literal("ARTIFACT"),
  artifact:HardeningArtifactAuthoritySchema}).strict();
export const HardeningReviewerEvidenceAuthoritySchema=z.object({evidenceId:z.string().min(1),eventType:z.string().min(1),
  evidenceHash:HashSchema,payloadHash:HashSchema,source:z.discriminatedUnion("kind",[
    HardeningEvidenceArtifactReferenceSchema,HardeningEvidenceLedgerReferenceSchema]),
  ledgerDependencies:z.array(HardeningEvidenceLedgerReferenceSchema),
  artifactDependencies:z.array(HardeningArtifactAuthoritySchema),
  authorityHash:HashSchema}).strict().superRefine((value,context)=>{
    const {authorityHash,...content}=value;
    if(sha256(content)!==authorityHash)context.addIssue({code:"custom",path:["authorityHash"],message:"evidence authority hash mismatch"});
    if(sha256(value.ledgerDependencies.map((item)=>`${item.table}:${item.rowId}`))!==sha256(
      [...value.ledgerDependencies].sort((a,b)=>compareCodeUnits(`${a.table}:${a.rowId}`,`${b.table}:${b.rowId}`))
        .map((item)=>`${item.table}:${item.rowId}`)))context.addIssue({code:"custom",path:["ledgerDependencies"],message:"ledger dependencies are not canonical"});
    if(sha256(value.artifactDependencies.map((item)=>item.artifactId))!==sha256(
      [...value.artifactDependencies].sort((a,b)=>compareCodeUnits(a.artifactId,b.artifactId)).map((item)=>item.artifactId)))
      context.addIssue({code:"custom",path:["artifactDependencies"],message:"artifact dependencies are not canonical"});
  });

export const HardeningSemanticLedgerTableSchema=z.enum(["task_manifest_versions","required_lane_contracts",
  "risk_assessments","audit_events","security_findings","git_operations","agent_executions",
  "test_executions","command_executions","engineer_run_lineage","hardening_start_operations"]);
const HardeningSemanticRowReferenceSchema=z.object({rowId:z.string().min(1),rowHash:HashSchema}).strict();
const HardeningSemanticLedgerSetSchema=z.object({table:HardeningSemanticLedgerTableSchema,
  rows:z.array(HardeningSemanticRowReferenceSchema),setHash:HashSchema}).strict().superRefine((value,context)=>{
    const sorted=[...value.rows].sort((a,b)=>compareCodeUnits(a.rowId,b.rowId));
    if(sha256(value.rows)!==sha256(sorted))context.addIssue({code:"custom",path:["rows"],message:"semantic rows are not canonical"});
    if(sha256(value.rows)!==value.setHash)context.addIssue({code:"custom",path:["setHash"],message:"semantic row set hash mismatch"});
  });
export const HardeningReviewerSemanticAuthoritySchema=z.object({
  policyVersion:z.literal("engineer-hardening-review-semantic-authority-v1"),
  ledgerSets:z.array(HardeningSemanticLedgerSetSchema),artifacts:z.array(HardeningArtifactAuthoritySchema),
  artifactSetHash:HashSchema,
  runRiskProjection:z.object({riskTier:z.enum(["LOW","MEDIUM","HIGH","CRITICAL"]),humanGateRequired:z.boolean(),
    projectionHash:HashSchema}).strict(),authorityHash:HashSchema,
}).strict().superRefine((value,context)=>{
  const sortedSets=[...value.ledgerSets].sort((a,b)=>compareCodeUnits(a.table,b.table));
  if(sha256(value.ledgerSets)!==sha256(sortedSets))context.addIssue({code:"custom",path:["ledgerSets"],
    message:"semantic ledger sets are not canonical"});
  const sortedArtifacts=[...value.artifacts].sort((a,b)=>compareCodeUnits(a.artifactId,b.artifactId));
  if(sha256(value.artifacts)!==sha256(sortedArtifacts)||new Set(value.artifacts.map((item)=>item.artifactId)).size!==
      value.artifacts.length)context.addIssue({code:"custom",path:["artifacts"],message:"semantic artifacts are not canonical"});
  if(sha256(value.artifacts)!==value.artifactSetHash)context.addIssue({code:"custom",path:["artifactSetHash"],
    message:"semantic artifact set hash mismatch"});
  const projection={riskTier:value.runRiskProjection.riskTier,humanGateRequired:value.runRiskProjection.humanGateRequired};
  if(sha256(projection)!==value.runRiskProjection.projectionHash)context.addIssue({code:"custom",
    path:["runRiskProjection","projectionHash"],message:"risk projection hash mismatch"});
  const {authorityHash,...content}=value;if(sha256(content)!==authorityHash)context.addIssue({code:"custom",
    path:["authorityHash"],message:"semantic authority hash mismatch"});
});

export const OptionalHardeningReviewInputAuthoritySchema=z.object({
  version:z.literal(2),policyVersion:z.literal("engineer-hardening-review-input-authority-v2"),runId:z.string().min(1),
  manifestHash:HashSchema,diffHash:HashSchema,resultCommitSha:z.string().regex(/^[a-f0-9]{40,64}$/i),
  checkpointArtifactId:z.string().min(1),checkpointArtifactHash:HashSchema,checkpointHash:HashSchema,
  reviewerInput:ReviewerInputSchema,evidenceAuthority:z.array(HardeningReviewerEvidenceAuthoritySchema),
  evidenceAuthorityHash:HashSchema,semanticAuthority:HardeningReviewerSemanticAuthoritySchema,
  requestAuthority:IsolatedReviewerRequestAuthoritySchema,authorityHash:HashSchema,
}).strict().superRefine((value,context)=>{
  const {authorityHash,...content}=value;
  if(sha256(content)!==authorityHash)context.addIssue({code:"custom",path:["authorityHash"],message:"review input authority hash mismatch"});
  if(sha256(value.evidenceAuthority)!==value.evidenceAuthorityHash)
    context.addIssue({code:"custom",path:["evidenceAuthorityHash"],message:"evidence authority bundle hash mismatch"});
  if(sha256(value.evidenceAuthority.map((item)=>item.evidenceId))!==sha256(
    [...value.evidenceAuthority].sort((a,b)=>compareCodeUnits(a.evidenceId,b.evidenceId)).map((item)=>item.evidenceId)))
    context.addIssue({code:"custom",path:["evidenceAuthority"],message:"evidence authority is not canonical"});
  if(sha256(value.reviewerInput)!==value.requestAuthority.reviewerInputHash)
    context.addIssue({code:"custom",path:["requestAuthority","reviewerInputHash"],message:"request authority input mismatch"});
  const expected=value.reviewerInput.trustedEvidence.map((item)=>({evidenceId:item.evidenceId,eventType:item.eventType,
    evidenceHash:item.sha256,payloadHash:sha256(item.payload)})).sort((a,b)=>compareCodeUnits(a.evidenceId,b.evidenceId)),
    actual=value.evidenceAuthority.map((item)=>({evidenceId:item.evidenceId,eventType:item.eventType,
      evidenceHash:item.evidenceHash,payloadHash:item.payloadHash}));
  if(sha256(actual)!==sha256(expected))context.addIssue({code:"custom",path:["evidenceAuthority"],
    message:"evidence authority does not exactly cover Reviewer input"});
});

export function hardeningCheckpointMilestoneKey(input:{
  kind:"OPENED"|"RESUMED"|"COMPLETED";runId:string;artifactId:string;artifactHash:string;
  checkpointHash:string;selectedEventId:string;selectedEventSequence:number;selectedEventStateVersion:number;
  selectedEventHash:string;
}):string{const namespace=input.kind==="OPENED"?"engineer-hardening-independent-checkpoint-opened-v2":
    input.kind==="RESUMED"?"engineer-hardening-independent-checkpoint-resumed-v2":
      "engineer-hardening-independent-checkpoint-completed-v2";
  return sha256({namespace,...input});}

export function validateOptionalHardeningCheckpointChain(input:{
  checkpoint:OptionalHardeningIndependentCheckpoint;artifact:ArtifactRecord;events:readonly RunStateEvent[];
  manifestHash:string;
}){
  const {checkpoint,artifact,events}=input;
  if(checkpoint.runId!==artifact.runId||checkpoint.manifestHash!==input.manifestHash)throw new Error("checkpoint identity mismatch");
  const heads=events.filter((event)=>event.eventId===checkpoint.selectedEventId&&
    event.sequence===checkpoint.selectedEventSequence&&event.stateVersion===checkpoint.selectedEventStateVersion&&
    event.nextState===checkpoint.selectedEventState&&event.reasonCode===checkpoint.selectedEventReasonCode&&
    sha256(event.evidenceIds)===checkpoint.selectedEventEvidenceHash&&sha256(event)===checkpoint.selectedEventHash);
  if(heads.length!==1)throw new Error("checkpoint head authority is invalid");
  const head=heads[0]!,prefix=[artifact.artifactId,artifact.sha256,checkpoint.checkpointHash];
  if(head.runId!==checkpoint.runId||head.nextState!=="SECURITY_REVIEW"||head.actorType!=="SUPERVISOR"||
    head.actorId!=="engineer-supervisor"||head.manifestHash!==checkpoint.manifestHash)
    throw new Error("checkpoint head projection is invalid");
  const epoch=(value:string)=>{const parsed=Date.parse(value);if(!Number.isFinite(parsed))throw new Error("checkpoint chain timestamp is invalid");
    return parsed;},headEpoch=epoch(head.timestamp),artifactEpoch=epoch(artifact.createdAt);
  if(artifactEpoch<headEpoch)throw new Error("checkpoint artifact predates its selected event");
  const byReason=(reason:string)=>events.filter((event)=>event.sequence>head.sequence&&event.reasonCode===reason);
  const opened=byReason("PHASE3_PROCESS_INTERRUPTED"),resumed=byReason("INDEPENDENT_VERIFICATION_CHECKPOINT_RESUMED"),
    completed=byReason("INDEPENDENT_VERIFICATION_COMPLETE");
  if(opened.length>1||resumed.length>1||completed.length>1)throw new Error("checkpoint milestone authority is ambiguous");
  const o=opened[0]??null,r=resumed[0]??null,c=completed[0]??null;
  if(r&&!o||c&&Boolean(o)!==Boolean(r))throw new Error("checkpoint milestone chain is incomplete");
  const exact=(event:RunStateEvent,kind:"OPENED"|"RESUMED"|"COMPLETED",previousState:string,nextState:string,
    sequence:number,stateVersion:number,exactEvidence:boolean)=>{
    const key=hardeningCheckpointMilestoneKey({kind,runId:checkpoint.runId,artifactId:artifact.artifactId,
      artifactHash:artifact.sha256,checkpointHash:checkpoint.checkpointHash,selectedEventId:checkpoint.selectedEventId,
      selectedEventSequence:checkpoint.selectedEventSequence,selectedEventStateVersion:checkpoint.selectedEventStateVersion,
      selectedEventHash:checkpoint.selectedEventHash});
    if(event.runId!==checkpoint.runId||event.sequence!==sequence||event.stateVersion!==stateVersion||
      event.previousState!==previousState||event.nextState!==nextState||event.idempotencyKey!==key||
      event.actorType!=="SUPERVISOR"||event.actorId!=="engineer-supervisor"||event.manifestHash!==checkpoint.manifestHash||
      event.evidenceIds.length<prefix.length||prefix.some((value,index)=>event.evidenceIds[index]!==value)||
      (exactEvidence&&event.evidenceIds.length!==prefix.length))throw new Error("checkpoint milestone binding is invalid");
    if(kind==="COMPLETED"){
      const suffix=event.evidenceIds.slice(prefix.length);
      if(new Set(suffix).size!==suffix.length||sha256(suffix)!==sha256([...suffix].sort()))
        throw new Error("checkpoint completion evidence is not canonical");
    }
  };
  const ingressTimes=hardeningReviewerIngressTimes({headTimestamp:head.timestamp,
    checkpointCreatedAt:artifact.createdAt,checkpointEvidence:checkpoint.verified.trustedEvidence});
  if(o){exact(o,"OPENED",head.nextState,"VERIFICATION_RECOVERY",head.sequence+1,head.stateVersion+1,true);
    if(o.timestamp!==ingressTimes.openedAt)throw new Error("checkpoint opened timestamp is not deterministic");}
  if(r){exact(r,"RESUMED","VERIFICATION_RECOVERY","SECURITY_REVIEW",o!.sequence+1,o!.stateVersion+1,true);
    if(r.timestamp!==ingressTimes.resumedAt)throw new Error("checkpoint resumed timestamp is not deterministic");}
  if(c){const predecessor=r??head;exact(c,"COMPLETED",predecessor.nextState,"REVIEWING",predecessor.sequence+1,
      predecessor.stateVersion+1,false);}
  let priorEpoch=headEpoch;
  for(const event of [o,r,c].filter(Boolean) as RunStateEvent[]){const eventEpoch=epoch(event.timestamp);
    if(eventEpoch<priorEpoch)throw new Error("checkpoint milestone timestamps regress");priorEpoch=eventEpoch;}
  if(c&&epoch(c.timestamp)<artifactEpoch)throw new Error("checkpoint completion predates its checkpoint artifact");
  if(c&&c.timestamp!==ingressTimes.completionAt)throw new Error("checkpoint completion timestamp is not deterministic");
  const last=c??r??o;
  if(last){
    const actual=events.filter((event)=>event.sequence>head.sequence&&event.sequence<=last.sequence).map((event)=>event.eventId),
      expected=(o?[o,r,c]:[c]).filter(Boolean).map((event)=>event!.eventId);
    if(sha256(actual)!==sha256(expected))throw new Error("checkpoint milestone chain contains an interposed event");
  }
  if(!c&&events.some((event)=>event.sequence>(last??head).sequence))
    throw new Error("checkpoint resumable window is not the current event head");
  return {head,opened:o,resumed:r,completed:c,prefix};
}
