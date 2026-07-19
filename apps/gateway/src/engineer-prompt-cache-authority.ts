import {
  HardeningPromptCacheDescriptorSchema,
  canonicalHardeningPromptCacheMaterial,
  canonicalJson,
} from "@zintus/engineer";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const PURPOSE="engineer-hardening-prompt-cache-v1" as const;
export const HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE="HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE" as const;
export const HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH="HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH" as const;

type Identity={version:1;purpose:typeof PURPOSE;keyId:string};
export type EngineerPromptCacheAuthority=
  |{status:"READY";secret:string;secretPath:string;identityPath:string;reservationCount:number}
  |{status:typeof HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE|typeof HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH;
    secret:undefined;secretPath:string;identityPath:string;reservationCount:number;detail:string};
export type EngineerPromptCacheAuthorityInspection={
  ok:boolean;state:"READY"|"NOT_INITIALIZED"|"IDENTITY_BOOTSTRAP_READY"|
    typeof HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE|typeof HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH;
  reservationCount:number;detail:string;
};

function identityFor(secret:string):Identity{return {version:1,purpose:PURPOSE,
  keyId:`sha256:${createHash("sha256").update("engineer-hardening-prompt-cache-key-identity-v1\0").update(secret).digest("hex")}`};}
function exactIdentity(value:unknown):Identity|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const row=value as Record<string,unknown>;
  if(Object.keys(row).sort().join(",")!=="keyId,purpose,version"||row.version!==1||row.purpose!==PURPOSE||
    typeof row.keyId!=="string"||!/^sha256:[a-f0-9]{64}$/.test(row.keyId))return null;
  return row as Identity;
}
function readOwnerOnly(path:string):string|null{
  let fd:number|null=null;
  try{
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);if(!stat.isFile()||(process.getuid!==undefined&&stat.uid!==process.getuid())||(stat.mode&0o077)!==0)return null;
    return readFileSync(fd,"utf8");
  }catch{return null;}finally{if(fd!==null)try{closeSync(fd);}catch{/* invalid authority remains unavailable */}}
}
function readSecret(path:string):string|null{
  const bytes=readOwnerOnly(path);if(bytes===null)return null;const value=bytes.trim();return /^[a-f0-9]{64}$/.test(value)?value:null;
}
function readIdentity(path:string):Identity|null{
  const bytes=readOwnerOnly(path);if(bytes===null)return null;try{return exactIdentity(JSON.parse(bytes));}catch{return null;}
}
function authorityDirectoryStatus(path:string):{ok:true}|{ok:false;detail:string}{
  const directory=dirname(path);
  if(!existsSync(directory))return {ok:true};
  let fd:number|null=null;
  try{
    fd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);
    if(!stat.isDirectory()||(process.getuid!==undefined&&stat.uid!==process.getuid())||(stat.mode&0o077)!==0)
      return {ok:false,detail:"Prompt-cache authority directory must be an owner-only directory (chmod 700)"};
    return {ok:true};
  }catch{
    return {ok:false,detail:"Prompt-cache authority directory is unavailable or unsafe"};
  }finally{if(fd!==null)try{closeSync(fd);}catch{/* inspection is fail closed */}}
}
function writeOwnerOnly(path:string,value:string):boolean{
  const directory=dirname(path);mkdirSync(directory,{recursive:true,mode:0o700});
  let authorityDirFd:number|null=null;
  try{
    authorityDirFd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(authorityDirFd);
    if(!stat.isDirectory()||(process.getuid!==undefined&&stat.uid!==process.getuid())||(stat.mode&0o077)!==0)
      throw new Error("Engineer prompt-cache authority directory must be owner-only");
  }finally{if(authorityDirFd!==null)closeSync(authorityDirFd);}
  const temporary=`${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;let fd:number|null=null,linked=false;
  try{
    fd=openSync(temporary,"wx",0o600);writeFileSync(fd,value,{encoding:"utf8"});fsyncSync(fd);closeSync(fd);fd=null;
    try{linkSync(temporary,path);linked=true;}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    if(linked){let dirFd:number|null=null;try{dirFd=openSync(directory,constants.O_RDONLY);fsyncSync(dirFd);}finally{if(dirFd!==null)closeSync(dirFd);}}
    return linked;
  }finally{if(fd!==null)try{closeSync(fd);}catch{/* cleanup below */}try{unlinkSync(temporary);}catch{/* already absent */}}
}

export function verifyEngineerPromptCacheReservationDescriptors(input:{dbPath:string;secret:string}):{
  ok:boolean;reservationCount:number;detail:string;
}{
  if(!existsSync(input.dbPath))return {ok:true,reservationCount:0,detail:"Engineer database is not initialized"};
  let db:Database|null=null,reservationCount=0;
  try{
    db=new Database(input.dbPath,{readonly:true});
    const table=db.query("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='hardening_child_model_reservations'").get();
    if(!table)return {ok:true,reservationCount:0,detail:"No hardening reservation table"};
    reservationCount=Number((db.query("SELECT COUNT(*) AS count FROM hardening_child_model_reservations").get() as {count:number}).count);
    if(!Number.isSafeInteger(reservationCount)||reservationCount<0)
      return {ok:false,reservationCount:0,detail:"Durable reservation cardinality is invalid"};
    const rows=db.query(`SELECT reservation.child_run_id,reservation.role,reservation.resolved_model,
      reservation.cache_policy_version,reservation.cache_accounting_version,reservation.static_prefix_hash,
      reservation.tool_schema_hash,reservation.prompt_cache_key_hash,reservation.cache_shard,
      reservation.cache_ttl_seconds,reservation.cache_breakpoint_count,run.user_id
      FROM hardening_child_model_reservations AS reservation
      LEFT JOIN engineer_runs AS run ON run.id=reservation.child_run_id
      ORDER BY reservation.child_run_id,reservation.id`).all() as Array<Record<string,unknown>>;
    if(rows.length!==reservationCount)return {ok:false,reservationCount,detail:"Durable reservation/run cardinality does not match"};
    for(const row of rows){
      if((row.role!=="BUILDER"&&row.role!=="REVIEWER")||typeof row.user_id!=="string"||
        typeof row.child_run_id!=="string"||typeof row.resolved_model!=="string")
        return {ok:false,reservationCount,detail:"A durable reservation has an invalid cache identity tuple"};
      const expected=canonicalHardeningPromptCacheMaterial({secret:input.secret,requesterUserId:row.user_id,
        childRunId:row.child_run_id,role:row.role,resolvedModel:row.resolved_model}).descriptor;
      const actual=HardeningPromptCacheDescriptorSchema.safeParse({cachePolicyVersion:row.cache_policy_version,
        cacheAccountingVersion:row.cache_accounting_version,staticPrefixHash:row.static_prefix_hash,
        toolSchemaHash:row.tool_schema_hash,promptCacheKeyHash:row.prompt_cache_key_hash,
        cacheShard:Number(row.cache_shard),cacheTtlSeconds:Number(row.cache_ttl_seconds),
        cacheBreakpointCount:Number(row.cache_breakpoint_count)});
      if(!actual.success||canonicalJson(actual.data)!==canonicalJson(expected))
        return {ok:false,reservationCount,detail:"The configured secret cannot reproduce every durable reservation cache descriptor"};
    }
    return {ok:true,reservationCount,detail:`Validated ${reservationCount} durable reservation cache descriptor(s)`};
  }catch(error){return {ok:false,reservationCount,detail:`Read-only reservation validation failed: ${error instanceof Error?error.message:String(error)}`};}
  finally{try{db?.close();}catch{/* preserve the validation result */}}
}

function loadEngineerPromptCacheAuthorityUnsafe(input:{secretPath:string;dbPath:string;identityPath?:string}):EngineerPromptCacheAuthority{
  const identityPath=input.identityPath??`${input.secretPath}.identity`;
  const directoryStatus=authorityDirectoryStatus(input.secretPath);
  if(!directoryStatus.ok)return {status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined,
    secretPath:input.secretPath,identityPath,reservationCount:0,detail:directoryStatus.detail};
  const secretExists=existsSync(input.secretPath),identityExists=existsSync(identityPath);
  let secret=secretExists?readSecret(input.secretPath):null;
  let identity=identityExists?readIdentity(identityPath):null;
  if(secretExists&&!secret){const inspection=verifyEngineerPromptCacheReservationDescriptors({dbPath:input.dbPath,secret:"0".repeat(64)});
    return {status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined,
      secretPath:input.secretPath,identityPath,reservationCount:inspection.reservationCount,
      detail:"Prompt-cache secret is not a valid owner-only 256-bit secret"};}
  if(identityExists&&!identity){const inspection=verifyEngineerPromptCacheReservationDescriptors({dbPath:input.dbPath,
    secret:secret??"0".repeat(64)});return {status:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,secret:undefined,
      secretPath:input.secretPath,identityPath,reservationCount:inspection.reservationCount,
      detail:"Prompt-cache identity is malformed or not owner-only"};}
  if(!secret){
    const inspection=verifyEngineerPromptCacheReservationDescriptors({dbPath:input.dbPath,secret:"0".repeat(64)});
    if(identity)return {status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined,
      secretPath:input.secretPath,identityPath,reservationCount:inspection.reservationCount,
      detail:"The original prompt-cache secret is missing; it was not regenerated"};
    if(inspection.reservationCount>0)return {status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined,
      secretPath:input.secretPath,identityPath,reservationCount:inspection.reservationCount,
      detail:"Durable hardening reservations exist; restore the original prompt-cache secret"};
    if(!inspection.ok)return {status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined,
      secretPath:input.secretPath,identityPath,reservationCount:inspection.reservationCount,detail:inspection.detail};
    const generated=randomBytes(32).toString("hex");
    if(writeOwnerOnly(input.secretPath,`${generated}\n`))secret=generated;else secret=readSecret(input.secretPath);
    if(!secret)return {status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined,
      secretPath:input.secretPath,identityPath,reservationCount:0,detail:"Prompt-cache secret creation raced with invalid local authority"};
  }
  const descriptors=verifyEngineerPromptCacheReservationDescriptors({dbPath:input.dbPath,secret});
  if(!descriptors.ok)return {status:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,secret:undefined,
    secretPath:input.secretPath,identityPath,reservationCount:descriptors.reservationCount,detail:descriptors.detail};
  const expectedIdentity=identityFor(secret);
  if(identity&&canonicalJson(identity)!==canonicalJson(expectedIdentity))return {status:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,
    secret:undefined,secretPath:input.secretPath,identityPath,reservationCount:descriptors.reservationCount,
    detail:"Prompt-cache secret does not match its durable machine identity"};
  if(!identity){
    if(writeOwnerOnly(identityPath,`${JSON.stringify(expectedIdentity)}\n`))identity=expectedIdentity;else identity=readIdentity(identityPath);
    if(!identity||canonicalJson(identity)!==canonicalJson(expectedIdentity))return {status:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,
      secret:undefined,secretPath:input.secretPath,identityPath,reservationCount:descriptors.reservationCount,
      detail:"Prompt-cache identity creation raced with different local authority"};
  }
  return {status:"READY",secret,secretPath:input.secretPath,identityPath,reservationCount:descriptors.reservationCount};
}

export function loadEngineerPromptCacheAuthority(input:{secretPath:string;dbPath:string;identityPath?:string}):EngineerPromptCacheAuthority{
  const identityPath=input.identityPath??`${input.secretPath}.identity`;
  try{return loadEngineerPromptCacheAuthorityUnsafe(input);}
  catch{
    const inspection=verifyEngineerPromptCacheReservationDescriptors({dbPath:input.dbPath,secret:"0".repeat(64)});
    return {status:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,secret:undefined,
      secretPath:input.secretPath,identityPath,reservationCount:inspection.reservationCount,
      detail:"Prompt-cache authority could not be initialized safely; verify owner-only permissions and restart the gateway"};
  }
}

/** Read-only doctor/preflight projection. It never returns secret material. */
export function inspectEngineerPromptCacheAuthority(input:{secretPath:string;dbPath:string;identityPath?:string}):EngineerPromptCacheAuthorityInspection{
  const directoryStatus=authorityDirectoryStatus(input.secretPath);
  if(!directoryStatus.ok)return {ok:false,state:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,
    reservationCount:0,detail:directoryStatus.detail};
  const identityPath=input.identityPath??`${input.secretPath}.identity`,secretExists=existsSync(input.secretPath),
    identityExists=existsSync(identityPath),secret=secretExists?readSecret(input.secretPath):null,
    identity=identityExists?readIdentity(identityPath):null;
  if(secretExists&&!secret){const check=verifyEngineerPromptCacheReservationDescriptors({dbPath:input.dbPath,secret:"0".repeat(64)});
    return {ok:false,state:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,reservationCount:check.reservationCount,
      detail:"Prompt-cache secret is invalid or not owner-only; restore the original owner-only secret"};}
  if(identityExists&&!identity){const check=verifyEngineerPromptCacheReservationDescriptors({dbPath:input.dbPath,secret:secret??"0".repeat(64)});
    return {ok:false,state:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,reservationCount:check.reservationCount,
      detail:"Prompt-cache identity is malformed or not owner-only"};}
  if(!secret){const check=verifyEngineerPromptCacheReservationDescriptors({dbPath:input.dbPath,secret:"0".repeat(64)});
    if(identity||check.reservationCount>0)return {ok:false,state:HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,
      reservationCount:check.reservationCount,detail:"Restore the original prompt-cache secret; automatic rotation is disabled"};
    return {ok:check.ok,state:check.ok?"NOT_INITIALIZED":HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE,
      reservationCount:check.reservationCount,detail:check.ok?"Prompt-cache authority is not initialized":check.detail};}
  const descriptors=verifyEngineerPromptCacheReservationDescriptors({dbPath:input.dbPath,secret});
  if(!descriptors.ok)return {ok:false,state:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,
    reservationCount:descriptors.reservationCount,detail:descriptors.detail};
  const expected=identityFor(secret);
  if(identity&&canonicalJson(identity)!==canonicalJson(expected))return {ok:false,state:HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH,
    reservationCount:descriptors.reservationCount,detail:"Prompt-cache secret does not match its durable machine identity"};
  return {ok:true,state:identity?"READY":"IDENTITY_BOOTSTRAP_READY",reservationCount:descriptors.reservationCount,
    detail:identity?descriptors.detail:"Current secret reproduces every reservation; identity can be initialized safely"};
}
