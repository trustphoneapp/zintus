import { describe, expect, test } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256 } from "./hash.js";
import {
  HardeningSeedAttestationSchema, HardeningStartOperationSchema, HardeningStartRequestSchema,
  SignedHardeningSeedAttestationSchema, createHardeningStartOperation,
  createSignedHardeningSeedAttestation, verifySignedHardeningSeedAttestation,
} from "./hardening-start-contracts.js";

const at="2026-07-18T12:00:00.000Z";
const h=(value:string)=>sha256(value);
const signer={algorithm:"HMAC-SHA256",keyId:"test-key",
  sign(payload:Uint8Array){return createHmac("sha256","test-only-key").update(payload).digest("hex");},
  verify(payload:Uint8Array,signature:string){const expected=Buffer.from(this.sign(payload),"hex");const actual=Buffer.from(signature,"hex");return actual.length===expected.length&&timingSafeEqual(actual,expected);}};

describe("Day 2A P5 canonical hardening-start contracts",()=>{
  test("accepts only the exact optimistic-concurrency start body and derives stable operation authority",()=>{
    const body={expectedChildStateVersion:0 as const,lineageId:h("lineage-id"),lineageHash:h("lineage-hash"),idempotencyKey:"start-once"};
    expect(HardeningStartRequestSchema.parse(body)).toEqual(body);
    expect(()=>HardeningStartRequestSchema.parse({...body,extra:true})).toThrow();
    expect(()=>HardeningStartRequestSchema.parse({...body,expectedChildStateVersion:1})).toThrow();
    const input={schemaVersion:1 as const,policyVersion:"engineer-hardening-start-operation-v1" as const,
      requesterUserId:"owner",childRunId:"hardening-child",...body,createdAt:at};
    const first=createHardeningStartOperation(input);const replay=createHardeningStartOperation(input);
    expect(replay).toEqual(first);expect(HardeningStartOperationSchema.parse(first)).toEqual(first);
    expect(()=>HardeningStartOperationSchema.parse({...first,lineageHash:h("tampered")})).toThrow();
    expect(()=>HardeningStartOperationSchema.parse({...first,operationHash:h("tampered")})).toThrow();
    expect(()=>HardeningStartOperationSchema.parse({...first,extra:true})).toThrow();
  });

  test("signs exact canonical HARDENING_SEED_VERIFIED authority and rejects every bound-hash drift",async()=>{
    const operation=createHardeningStartOperation({schemaVersion:1,policyVersion:"engineer-hardening-start-operation-v1",
      requesterUserId:"owner",childRunId:"hardening-child",expectedChildStateVersion:0,lineageId:h("lineage-id"),lineageHash:h("lineage-hash"),idempotencyKey:"start-once",createdAt:at});
    const input={schemaVersion:1 as const,policyVersion:"engineer-hardening-seed-attestation-v1" as const,
      attestationType:"HARDENING_SEED_VERIFIED" as const,operationId:operation.operationId,operationHash:operation.operationHash,
      rootRunId:"root",parentRunId:"parent",childRunId:"hardening-child",requesterUserId:"owner",repositoryId:"repo",
      lineageId:operation.lineageId,lineageHash:operation.lineageHash,parentCheckpointId:h("checkpoint-id"),parentCheckpointHash:h("checkpoint-hash"),
      baseCommitSha:"a".repeat(40),seedResultCommitSha:"b".repeat(40),seedTreeHash:h("tree"),seedDiffHash:h("diff"),
      imageDigest:h("image"),environmentDigest:h("environment"),dependencyHash:h("dependencies"),createdAt:at};
    const signed=await createSignedHardeningSeedAttestation(input,signer);
    expect((await verifySignedHardeningSeedAttestation(signed,signer)).attestation.attestationType).toBe("HARDENING_SEED_VERIFIED");
    expect(SignedHardeningSeedAttestationSchema.parse(signed)).toEqual(signed);
    for(const field of ["lineageHash","parentCheckpointHash","seedTreeHash","seedDiffHash","imageDigest","environmentDigest","dependencyHash"] as const){
      expect(()=>HardeningSeedAttestationSchema.parse({...signed.attestation,[field]:h(`tampered-${field}`)}),field).toThrow();
    }
    expect(()=>SignedHardeningSeedAttestationSchema.parse({...signed,statementJson:signed.statementJson+" "})).toThrow();
    expect(()=>SignedHardeningSeedAttestationSchema.parse({...signed,extra:true})).toThrow();
    await expect(verifySignedHardeningSeedAttestation({...signed,signature:"00"},signer)).rejects.toThrow("signature is invalid");
  });
});
