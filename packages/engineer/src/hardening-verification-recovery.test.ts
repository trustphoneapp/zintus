import {describe,expect,test} from "bun:test";
import type {ArtifactRecord} from "./execution-contracts.js";
import type {RunState,RunStateEvent} from "./contracts.js";
import {hardeningCheckpointMilestoneKey,OptionalHardeningIndependentCheckpointSchema,
  projectHardeningArtifactAuthority,validateOptionalHardeningCheckpointChain} from
  "./hardening-verification-recovery.js";
import {compareCodeUnits,sha256,sha256Bytes} from "./hash.js";

const runId="hardening-chain",manifestHash=sha256("manifest"),diffHash=sha256(""),resultCommitSha="a".repeat(40);
function artifact(artifactId:string,type:string,bytes="{}"):ArtifactRecord{return {artifactId,runId,type,
  sha256:sha256Bytes(Buffer.from(bytes)),producerType:"SYSTEM",producerId:"engineer-verification",
  storageReference:`/tmp/${artifactId}`,sizeBytes:Buffer.byteLength(bytes),trusted:true,createdAt:"2026-07-18T12:00:00.000Z"};}
const report=artifact("security-report","SECURITY_REPORT"),diff=artifact("final-diff","FINAL_DIFF",""),checkpointArtifact=artifact(
  "independent-checkpoint","INDEPENDENT_VERIFICATION_CHECKPOINT");
const head:RunStateEvent={eventId:"head",runId,sequence:10,previousState:"INTEGRATION_TESTING",nextState:"SECURITY_REVIEW",
  reasonCode:"ENTER_SECURITY_REVIEW",actorType:"SUPERVISOR",actorId:"engineer-supervisor",timestamp:"2026-07-18T12:00:00.000Z",
  evidenceIds:[],manifestHash,stateVersion:10,idempotencyKey:"head-key"};
const checkpointContent={version:2 as const,runId,manifestHash,diffHash,resultCommitSha,diffArtifactId:diff.artifactId,
  diffArtifactHash:diff.sha256,selectedEventId:head.eventId,selectedEventSequence:head.sequence,
  selectedEventStateVersion:head.stateVersion,selectedEventState:head.nextState,selectedEventReasonCode:head.reasonCode,
  selectedEventEvidenceHash:sha256(head.evidenceIds),selectedEventHash:sha256(head),
  verified:{executions:[],securityFindings:[],trustedEvidence:[],
    securityReportArtifact:projectHardeningArtifactAuthority(report)}};
const checkpoint=OptionalHardeningIndependentCheckpointSchema.parse({...checkpointContent,checkpointHash:sha256(checkpointContent)}),
  prefix=[checkpointArtifact.artifactId,checkpointArtifact.sha256,checkpoint.checkpointHash];
function milestone(kind:"OPENED"|"RESUMED"|"COMPLETED",sequence:number,previousState:RunState,nextState:RunState,
  reasonCode:string,evidenceIds=prefix):RunStateEvent{return {eventId:`${kind}-${sequence}`,runId,sequence,previousState,nextState,
    reasonCode,actorType:"SUPERVISOR",actorId:"engineer-supervisor",timestamp:kind==="OPENED"?
      "2026-07-18T12:00:00.000Z":kind==="RESUMED"?"2026-07-18T12:00:00.001Z":"2026-07-18T12:00:00.005Z",
    evidenceIds:[...evidenceIds],manifestHash,stateVersion:sequence,idempotencyKey:hardeningCheckpointMilestoneKey({kind,runId,
      artifactId:checkpointArtifact.artifactId,artifactHash:checkpointArtifact.sha256,checkpointHash:checkpoint.checkpointHash,
      selectedEventId:checkpoint.selectedEventId,selectedEventSequence:checkpoint.selectedEventSequence,
      selectedEventStateVersion:checkpoint.selectedEventStateVersion,selectedEventHash:checkpoint.selectedEventHash})};}

describe("optional-hardening verification checkpoint chain",()=>{
  test("keeps artifact authority and checkpoint hashes portable across storage roots without leaking paths",()=>{
    const left={...report,storageReference:"/private/machine-a/artifacts/security-report"},
      right={...report,storageReference:"/different/machine-b/artifacts/security-report"},
      leftAuthority=projectHardeningArtifactAuthority(left),rightAuthority=projectHardeningArtifactAuthority(right),
      leftContent={...checkpointContent,verified:{...checkpointContent.verified,securityReportArtifact:leftAuthority}},
      rightContent={...checkpointContent,verified:{...checkpointContent.verified,securityReportArtifact:rightAuthority}},
      serialized=JSON.stringify({...leftContent,checkpointHash:sha256(leftContent)});
    expect({sameAuthority:sha256(leftAuthority)===sha256(rightAuthority),
      sameCheckpoint:sha256(leftContent)===sha256(rightContent),storageReference:serialized.includes("storageReference"),
      leftRoot:serialized.includes("/private/machine-a"),rightRoot:serialized.includes("/different/machine-b")}).toEqual({
        sameAuthority:true,sameCheckpoint:true,storageReference:false,leftRoot:false,rightRoot:false});
  });

  test("orders mixed named, UUID, hash, and punctuation identifiers by locale-independent code units",()=>{
    const identifiers=["named-review","550e8400-e29b-41d4-a716-446655440000","sha256:abc","_authority","-evidence","Z","a"];
    expect([...identifiers].sort(compareCodeUnits)).toEqual([
      "-evidence","550e8400-e29b-41d4-a716-446655440000","Z","_authority","a","named-review","sha256:abc",
    ]);
  });

  test("uses independently asserted v2 milestone namespaces",()=>{
    const material={runId,artifactId:checkpointArtifact.artifactId,artifactHash:checkpointArtifact.sha256,
      checkpointHash:checkpoint.checkpointHash,selectedEventId:checkpoint.selectedEventId,
      selectedEventSequence:checkpoint.selectedEventSequence,
      selectedEventStateVersion:checkpoint.selectedEventStateVersion,selectedEventHash:checkpoint.selectedEventHash};
    expect(hardeningCheckpointMilestoneKey({kind:"OPENED",...material})).toBe(sha256({
      namespace:"engineer-hardening-independent-checkpoint-opened-v2",kind:"OPENED",...material}));
    expect(hardeningCheckpointMilestoneKey({kind:"RESUMED",...material})).toBe(sha256({
      namespace:"engineer-hardening-independent-checkpoint-resumed-v2",kind:"RESUMED",...material}));
    expect(hardeningCheckpointMilestoneKey({kind:"COMPLETED",...material})).toBe(sha256({
      namespace:"engineer-hardening-independent-checkpoint-completed-v2",kind:"COMPLETED",...material}));
  });

  test("accepts exact normal and crash-recovery chains plus each resumable prefix",()=>{
    const c=milestone("COMPLETED",11,"SECURITY_REVIEW","REVIEWING","INDEPENDENT_VERIFICATION_COMPLETE",
      [...prefix,"authority-id",sha256("authority")]);
    c.timestamp="2026-07-18T12:00:00.005Z";
    // Preserve the fixed three-item prefix; only the suffix is canonical.
    c.evidenceIds=[...prefix,...["authority-id",sha256("authority")].sort()];
    expect(validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,events:[head,c],manifestHash}).completed?.eventId)
      .toBe(c.eventId);
    const o=milestone("OPENED",11,"SECURITY_REVIEW","VERIFICATION_RECOVERY","PHASE3_PROCESS_INTERRUPTED"),
      r=milestone("RESUMED",12,"VERIFICATION_RECOVERY","SECURITY_REVIEW","INDEPENDENT_VERIFICATION_CHECKPOINT_RESUMED"),
      recoveredC=milestone("COMPLETED",13,"SECURITY_REVIEW","REVIEWING","INDEPENDENT_VERIFICATION_COMPLETE",
        [...prefix,...["authority-id",sha256("authority")].sort()]);
    recoveredC.timestamp="2026-07-18T12:00:00.005Z";
    expect(validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,events:[head],manifestHash}).completed).toBeNull();
    expect(validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,events:[head,o],manifestHash}).opened?.eventId).toBe(o.eventId);
    expect(validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,events:[head,o,r],manifestHash}).resumed?.eventId).toBe(r.eventId);
    expect(validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,events:[head,o,r,recoveredC],manifestHash})
      .completed?.eventId).toBe(recoveredC.eventId);
  });

  test("rejects interposed, duplicated, rebound, and noncanonical milestones",()=>{
    const o=milestone("OPENED",11,"SECURITY_REVIEW","VERIFICATION_RECOVERY","PHASE3_PROCESS_INTERRUPTED"),
      r=milestone("RESUMED",12,"VERIFICATION_RECOVERY","SECURITY_REVIEW","INDEPENDENT_VERIFICATION_CHECKPOINT_RESUMED"),
      c=milestone("COMPLETED",13,"SECURITY_REVIEW","REVIEWING","INDEPENDENT_VERIFICATION_COMPLETE",
        [...prefix,...["authority-id",sha256("authority")].sort()]);
    c.timestamp="2026-07-18T12:00:00.005Z";
    const foreign={...r,eventId:"foreign",reasonCode:"FOREIGN_EVENT",idempotencyKey:"foreign"};
    expect(()=>validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,events:[head,o,foreign,c],manifestHash})).toThrow();
    expect(()=>validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,events:[head,o,{...o,eventId:"o2"}],manifestHash})).toThrow();
    expect(()=>validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,events:[head,{...o,idempotencyKey:"wrong"}],manifestHash})).toThrow();
    expect(()=>validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,
      events:[head,o,r,{...c,evidenceIds:[...prefix,"z","a"]}],manifestHash})).toThrow();
    expect(()=>validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,
      events:[head,o,r,{...c,timestamp:"2026-07-18T11:59:59.999Z"}],manifestHash})).toThrow("timestamps regress");
    expect(()=>validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,
      events:[head,o,r,{...c,timestamp:"2026-07-18T12:00:00.006Z"}],manifestHash})).toThrow(
        "completion timestamp is not deterministic");
  });
});
