import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HardeningReadinessBanner, HARDENING_DEGRADED_COPY } from "../app/(app)/engineer/EngineerHardeningReadiness";
import { getEngineerHardeningReadiness } from "./engineer";

const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});

describe("Engineer optional-hardening readiness UI",()=>{
  test("READY hides the banner",()=>{
    expect(renderToStaticMarkup(<HardeningReadinessBanner state="READY"/>)).toBe("");
  });

  test("DEGRADED and network-unknown modes render only fixed safe guidance",()=>{
    for(const state of ["DEGRADED","UNKNOWN"] as const){
      const markup=renderToStaticMarkup(<HardeningReadinessBanner state={state}/>);
      expect(markup).toContain(HARDENING_DEGRADED_COPY);
      expect(markup).toContain('data-hardening-mutations-disabled="true"');
      expect(markup).toContain('role="status"');
      expect(markup).not.toContain("secretPath");
      expect(markup).not.toContain("reservationId");
    }
  });

  test("readiness parsing discards raw gateway details, paths, and secret-like values",async()=>{
    globalThis.fetch=Object.assign(async()=>new Response(JSON.stringify({
      readiness:{state:"READY"},hardening:{state:"DEGRADED",code:"HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH",
        message:"raw /Users/private/prompt-cache.secret abcdef0123456789"},
    }),{status:503,headers:{"Content-Type":"application/json"}}),{preconnect:originalFetch.preconnect});
    const result=await getEngineerHardeningReadiness();
    expect(result).toEqual({state:"DEGRADED",code:"HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH"});
    expect(JSON.stringify(result)).not.toContain("/Users/private");
    expect(JSON.stringify(result)).not.toContain("abcdef");
  });

  test("malformed or unreachable readiness fails closed without inventing READY",async()=>{
    globalThis.fetch=Object.assign(async()=>new Response("{}",{status:200,headers:{"Content-Type":"application/json"}}),
      {preconnect:originalFetch.preconnect});
    await expect(getEngineerHardeningReadiness()).rejects.toThrow("readiness is unavailable");
  });
});
