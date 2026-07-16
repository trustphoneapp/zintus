import { z } from "zod";
import { RepositoryReferenceSchema } from "./contracts.js";

export const RepositoryAdmissionSourceSchema = z.enum([
  "CONFIGURED_CANONICAL",
  "CONNECTOR_AUTHORIZED",
]);
export const RepositoryAdmissionStatusSchema = z.enum(["ACTIVE", "REVOKED"]);

export const RepositoryAdmissionSchema = z.object({
  admissionId: z.string().min(1).max(200),
  ownerUserId: z.string().min(1).max(200),
  repository: RepositoryReferenceSchema,
  source: RepositoryAdmissionSourceSchema,
  authorizationSubject: z.string().min(1).max(500),
  authorizationEvidenceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/i),
  authorizationExpiresAt: z.string().datetime().nullable(),
  authorizationGeneration: z.number().int().positive(),
  status: RepositoryAdmissionStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RepositoryAdmissionSource = z.infer<typeof RepositoryAdmissionSourceSchema>;
export type RepositoryAdmissionStatus = z.infer<typeof RepositoryAdmissionStatusSchema>;
export type RepositoryAdmission = z.infer<typeof RepositoryAdmissionSchema>;

export interface RegisterRepositoryAdmissionInput {
  admissionId: string;
  ownerUserId: string;
  repository: z.infer<typeof RepositoryReferenceSchema>;
  source: RepositoryAdmissionSource;
  authorizationSubject: string;
  authorizationEvidenceHash: string;
  authorizationExpiresAt?: string | null;
  authorizationGeneration?: number;
  existingBasePolicy?: "REQUIRE_EXACT" | "PRESERVE_EXISTING";
  now: string;
}
