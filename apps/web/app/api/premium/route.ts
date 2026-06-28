// Premium / managed-tier API — PLACEHOLDER.
//
// Intentionally empty. Managed keys are gated off (MANAGED_KEYS_AVAILABLE=false,
// no custody), so there is no live premium plane yet. This stub exists so the
// route is reserved and the owner can fill in the real implementation later
// (e.g. tier/entitlement lookup, managed-token balance, Stripe subscription
// status). Until then it returns a clear "not configured" response — it never
// pretends a paid product is live.
//
// TODO(owner): implement premium tier/entitlement + managed-token balance here.

export async function GET() {
  return Response.json(
    {
      premium: "not_configured",
      message:
        "Premium/managed tiers are not enabled yet. BYOK (free core) is fully available.",
    },
    { status: 501 },
  );
}

export async function POST() {
  return Response.json(
    {
      premium: "not_configured",
      message: "Premium endpoint is a placeholder — not yet implemented.",
    },
    { status: 501 },
  );
}
