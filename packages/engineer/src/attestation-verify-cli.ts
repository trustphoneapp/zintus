import { readFileSync } from "node:fs";
import {
  createHmacProvenanceSigner,
  verifyProvenanceAttestation,
  type ProvenanceVerificationResult,
} from "./attestation.js";

/**
 * Bun-runnable offline verifier for an exported DSSE-wrapped provenance
 * attestation:
 *
 *   ENGINEER_ATTESTATION_HMAC_SECRET=... ENGINEER_ATTESTATION_KEY_ID=... \
 *     bun run packages/engineer/src/attestation-verify-cli.ts path/to/envelope.json
 *
 * The HMAC secret is read from the environment (the gateway-held secret) and is
 * never accepted as a command-line argument, so it does not land in process
 * listings or shell history. A real Sigstore/KMS backend would verify against a
 * public key instead -- that is the [HUMAN]-gated integration.
 */

export interface CliOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runAttestationVerifyCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<CliOutcome> {
  const path = argv[0];
  if (!path) {
    return { exitCode: 2, stdout: "", stderr: "usage: attestation-verify-cli <envelope.json>\n" };
  }
  const secret = env.ENGINEER_ATTESTATION_HMAC_SECRET;
  const keyId = env.ENGINEER_ATTESTATION_KEY_ID;
  if (!secret || !keyId) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "ENGINEER_ATTESTATION_HMAC_SECRET and ENGINEER_ATTESTATION_KEY_ID must be set\n",
    };
  }

  let envelopeUnknown: unknown;
  try {
    envelopeUnknown = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `cannot read/parse ${path}: ${(error as Error).message}\n` };
  }

  let verifier;
  try {
    verifier = createHmacProvenanceSigner({ secret, keyId });
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }

  const result: ProvenanceVerificationResult = await verifyProvenanceAttestation(envelopeUnknown, verifier);
  if (result.ok) {
    const subject = result.statement.subject[0];
    return {
      exitCode: 0,
      stdout: `VERIFIED subject=${subject.name} digest=sha256:${subject.digest.sha256}\n`,
      stderr: "",
    };
  }
  return { exitCode: 1, stdout: "", stderr: `REJECTED ${result.code}: ${result.message}\n` };
}

if (import.meta.main) {
  const outcome = await runAttestationVerifyCli(process.argv.slice(2), process.env);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exit(outcome.exitCode);
}
