import type { ArtifactRecord } from "./execution-contracts.js";
import type { ReviewerInput } from "./contracts.js";
import type { RiskAssessment } from "./contracts.js";
import type { TestIntegrityComparison } from "./test-integrity.js";
import { HardeningReviewerEvidenceAuthoritySchema,HardeningReviewerSemanticAuthoritySchema,
  HardeningSemanticLedgerTableSchema,hardeningFinalRiskAuditId,hardeningPreReviewAuditId,
  projectHardeningArtifactAuthority,type HardeningArtifactAuthority } from
  "./hardening-verification-recovery.js";
import { canonicalJson, compareCodeUnits, sha256 } from "./hash.js";

type RunRecords=Record<string,Array<Record<string,unknown>>|undefined>;
export type HardeningPendingSemanticRow={table:"risk_assessments"|"audit_events";row:Record<string,unknown>};

export function buildHardeningPendingSemanticRows(input:{runId:string;checkpointHash:string;
  preReviewArtifact:ArtifactRecord;preReview:TestIntegrityComparison;riskAssessment:RiskAssessment}):
  HardeningPendingSemanticRow[]{
  const integrityDetails={artifactId:input.preReviewArtifact.artifactId,
    comparisonHash:input.preReview.comparisonHash,baselineHash:input.preReview.baselineHash,
    stage:input.preReview.stage,passed:input.preReview.passed},riskDetails={
      assessmentId:input.riskAssessment.assessmentId,riskTier:input.riskAssessment.riskTier,
      matchedRules:input.riskAssessment.matchedRules};
  return [{table:"risk_assessments",row:{id:input.riskAssessment.assessmentId,run_id:input.runId,
    risk_tier:input.riskAssessment.riskTier,human_gate_required:input.riskAssessment.humanGateRequired?1:0,
    rule_version:input.riskAssessment.ruleVersion,matched_rules_json:canonicalJson(input.riskAssessment.matchedRules),
    features_json:canonicalJson(input.riskAssessment.features),assessed_at:input.riskAssessment.assessedAt}},
  {table:"audit_events",row:{id:hardeningPreReviewAuditId({runId:input.runId,checkpointHash:input.checkpointHash,
    comparisonHash:input.preReview.comparisonHash}),run_id:input.runId,action:"TEST_INTEGRITY_ATTESTED",
    actor_type:"SUPERVISOR",actor_id:"engineer-supervisor-test-integrity",details_json:canonicalJson(integrityDetails),
    created_at:input.preReviewArtifact.createdAt}},
  {table:"audit_events",row:{id:hardeningFinalRiskAuditId({runId:input.runId,checkpointHash:input.checkpointHash,
    assessmentId:input.riskAssessment.assessmentId}),run_id:input.runId,action:"RISK_ASSESSED",
    actor_type:"SUPERVISOR",actor_id:"risk-engine",details_json:canonicalJson(riskDetails),
    created_at:input.riskAssessment.assessedAt}}];
}

function exactRow(records:RunRecords,table:"test_executions"|"command_executions",rowId:string,runId:string){
  const rows=(records[table]??[]).filter((row)=>String(row.id)===rowId&&String(row.run_id)===runId);
  if(rows.length!==1)throw new Error(`Reviewer evidence ${table}:${rowId} is not exact`);
  return {kind:"LEDGER_ROW" as const,table,rowId,rowHash:sha256(rows[0])};
}

function exactArtifact(artifacts:readonly ArtifactRecord[],artifactId:string,expectedHash:string|undefined,
  readArtifact:(artifact:ArtifactRecord)=>Uint8Array){
  const matches=artifacts.filter((artifact)=>artifact.artifactId===artifactId&&
    (expectedHash===undefined||artifact.sha256===expectedHash));
  if(matches.length!==1)throw new Error(`Reviewer evidence artifact ${artifactId} is not exact`);
  readArtifact(matches[0]!);return matches[0]!;
}

/** Resolve every Reviewer evidence identity to an exact durable row and byte graph. */
export function resolveHardeningReviewerEvidenceAuthority(input:{reviewerInput:ReviewerInput;
  artifacts:readonly ArtifactRecord[];runRecords:RunRecords;readArtifact:(artifact:ArtifactRecord)=>Uint8Array}){
  const entries=input.reviewerInput.trustedEvidence.map((evidence)=>{
    if(evidence.runId!==input.reviewerInput.runId||evidence.sha256!==sha256(evidence.payload))
      throw new Error(`Reviewer evidence ${evidence.evidenceId} is not payload-bound`);
    const sourceArtifacts=input.artifacts.filter((artifact)=>artifact.artifactId===evidence.evidenceId),
      artifactDependencies=new Map<string,ArtifactRecord>(),ledgerDependencies=[] as Array<{
        kind:"LEDGER_ROW";table:"test_executions"|"command_executions";rowId:string;rowHash:string}>;
    let source:{kind:"ARTIFACT";artifact:HardeningArtifactAuthority}|{kind:"LEDGER_ROW";table:"test_executions";
      rowId:string;rowHash:string};
    if(sourceArtifacts.length){
      if(sourceArtifacts.length!==1)throw new Error(`Reviewer evidence artifact ${evidence.evidenceId} is ambiguous`);
      const artifact=exactArtifact(input.artifacts,evidence.evidenceId,evidence.sha256,input.readArtifact);
      if(!artifact.trusted||artifact.runId!==evidence.runId||artifact.producerType!==evidence.producerType||
        artifact.producerId!==evidence.producerId)throw new Error(`Reviewer evidence artifact ${evidence.evidenceId} authority is invalid`);
      let parsed:unknown;try{parsed=JSON.parse(Buffer.from(input.readArtifact(artifact)).toString("utf8"));}
      catch{throw new Error(`Reviewer evidence artifact ${evidence.evidenceId} is not canonical JSON`);}
      if(canonicalJson(parsed)!==canonicalJson(evidence.payload))
        throw new Error(`Reviewer evidence artifact ${evidence.evidenceId} payload changed`);
      source={kind:"ARTIFACT",artifact:projectHardeningArtifactAuthority(artifact)};
    }else{
      if(evidence.eventType!=="INDEPENDENT_VERIFICATION"||evidence.producerType!=="EXECUTOR")
        throw new Error(`Reviewer evidence ${evidence.evidenceId} has no durable source`);
      const row=exactRow(input.runRecords,"test_executions",evidence.evidenceId,evidence.runId);
      source={...row,table:"test_executions"};
      const commandExecutionId=evidence.payload.commandExecutionId;
      if(typeof commandExecutionId!=="string"||!commandExecutionId)
        throw new Error(`Reviewer evidence ${evidence.evidenceId} lacks its command row`);
      ledgerDependencies.push(exactRow(input.runRecords,"command_executions",commandExecutionId,evidence.runId));
    }
    const visit=(candidate:unknown):void=>{
      if(Array.isArray(candidate)){for(const item of candidate)visit(item);return;}
      if(!candidate||typeof candidate!=="object")return;const row=candidate as Record<string,unknown>;
      if(typeof row.artifactId==="string"&&row.artifactId!==evidence.evidenceId){
        const artifact=exactArtifact(input.artifacts,row.artifactId,typeof row.sha256==="string"?row.sha256:undefined,
          input.readArtifact),existing=artifactDependencies.get(artifact.artifactId);
        if(existing&&sha256(existing)!==sha256(artifact))throw new Error(`Reviewer nested artifact ${artifact.artifactId} conflicts`);
        artifactDependencies.set(artifact.artifactId,artifact);
      }
      for(const value of Object.values(row))visit(value);
    };visit(evidence.payload);
    const content={evidenceId:evidence.evidenceId,eventType:evidence.eventType,evidenceHash:evidence.sha256,
      payloadHash:sha256(evidence.payload),source,
      ledgerDependencies:ledgerDependencies.sort((a,b)=>compareCodeUnits(`${a.table}:${a.rowId}`,`${b.table}:${b.rowId}`)),
      artifactDependencies:[...artifactDependencies.values()].sort((a,b)=>compareCodeUnits(a.artifactId,b.artifactId))
        .map(projectHardeningArtifactAuthority)};
    return HardeningReviewerEvidenceAuthoritySchema.parse({...content,authorityHash:sha256(content)});
  }).sort((a,b)=>compareCodeUnits(a.evidenceId,b.evidenceId));
  if(new Set(entries.map((entry)=>entry.evidenceId)).size!==entries.length)
    throw new Error("Reviewer evidence authority repeats an evidence ID");
  return entries;
}

const SEMANTIC_TABLES=HardeningSemanticLedgerTableSchema.options;
const SEMANTIC_ARTIFACT_TYPES=new Set(["TEST_BASELINE_MANIFEST","TEST_INTEGRITY_COMPARISON","TEST_ADVISORY",
  "VERIFICATION_COVERAGE_MATRIX","SECURITY_REPORT","ADVERSARIAL_COVERAGE_REPORT","FINAL_CHANGE_SCOPE_ATTESTATION"]);
function semanticRowId(table:(typeof SEMANTIC_TABLES)[number],row:Record<string,unknown>):string{
  const key=table==="required_lane_contracts"?"contract_hash":"id",value=row[key];
  if(typeof value!=="string"||!value)throw new Error(`semantic ${table} row has no stable identity`);
  return value;
}

/** Freeze every durable dependency that semantic Reviewer preflight reads implicitly. */
export function resolveHardeningReviewerSemanticAuthority(input:{reviewerInput:ReviewerInput;
  artifacts:readonly ArtifactRecord[];runRecords:RunRecords;pendingRows?:readonly HardeningPendingSemanticRow[];
  readArtifact:(artifact:ArtifactRecord)=>Uint8Array}){
  if(!input.reviewerInput.riskAssessment)throw new Error("hardening Reviewer semantic authority requires final risk");
  const pendingByTable=new Map<string,Record<string,unknown>[]>();
  for(const item of input.pendingRows??[])pendingByTable.set(item.table,[...(pendingByTable.get(item.table)??[]),item.row]);
  const ledgerSets=SEMANTIC_TABLES.map((table)=>{
    let rows=[...(input.runRecords[table]??[]),...(pendingByTable.get(table)??[])];
    if(table==="audit_events")rows=rows.filter((row)=>["VERIFICATION_EXECUTED","TEST_INTEGRITY_ATTESTED","RISK_ASSESSED"]
      .includes(String(row.action)));
    if(table==="agent_executions")rows=rows.filter((row)=>String(row.role)==="TESTER");
    const byId=new Map<string,Record<string,unknown>>();
    for(const row of rows){const rowId=semanticRowId(table,row),existing=byId.get(rowId);
      if(existing&&canonicalJson(existing)!==canonicalJson(row))throw new Error(`semantic ${table}:${rowId} conflicts`);
      byId.set(rowId,row);}
    const references=[...byId].map(([rowId,row])=>({rowId,rowHash:sha256(row)}))
      .sort((a,b)=>compareCodeUnits(a.rowId,b.rowId));
    return {table,rows:references,setHash:sha256(references)};
  }).sort((a,b)=>compareCodeUnits(a.table,b.table));
  const artifactMap=new Map<string,ArtifactRecord>();
  for(const artifact of input.artifacts.filter((item)=>SEMANTIC_ARTIFACT_TYPES.has(item.type))){
    const existing=artifactMap.get(artifact.artifactId);
    if(existing&&canonicalJson(existing)!==canonicalJson(artifact))throw new Error(
      `semantic artifact ${artifact.artifactId} conflicts`);
    input.readArtifact(artifact);artifactMap.set(artifact.artifactId,artifact);
  }
  const artifacts=[...artifactMap.values()].sort((a,b)=>compareCodeUnits(a.artifactId,b.artifactId))
    .map(projectHardeningArtifactAuthority),projection={
    riskTier:input.reviewerInput.riskAssessment.riskTier,
    humanGateRequired:input.reviewerInput.riskAssessment.humanGateRequired},content={
      policyVersion:"engineer-hardening-review-semantic-authority-v1" as const,ledgerSets,artifacts,
      artifactSetHash:sha256(artifacts),runRiskProjection:{...projection,projectionHash:sha256(projection)}};
  const set=(table:(typeof SEMANTIC_TABLES)[number])=>ledgerSets.find((item)=>item.table===table)!.rows;
  if(set("task_manifest_versions").length<1||set("required_lane_contracts").length!==1||
      set("test_executions").length<1||set("command_executions").length<1||
      !set("risk_assessments").some((item)=>item.rowId===input.reviewerInput.riskAssessment!.assessmentId)||
      artifacts.filter((item)=>item.type==="TEST_BASELINE_MANIFEST").length!==1)
    throw new Error("hardening Reviewer semantic authority is incomplete");
  return HardeningReviewerSemanticAuthoritySchema.parse({...content,authorityHash:sha256(content)});
}
