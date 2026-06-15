import { createProvider } from "@multipleai/providers";
import { isProviderId } from "@multipleai/types";

export const runtime = "nodejs";

const VALIDATE_WORKER_URL = process.env.VALIDATE_WORKER_URL;

export async function POST(request: Request) {
  const body = (await request.json()) as { providerId?: string; key?: string };

  if (!body.providerId || !body.key) {
    return Response.json(
      { valid: false, error: "providerId and key are required" },
      { status: 400 },
    );
  }

  if (!isProviderId(body.providerId)) {
    return Response.json(
      { valid: false, error: `Unknown provider: ${body.providerId}` },
      { status: 400 },
    );
  }

  if (VALIDATE_WORKER_URL) {
    const upstream = await fetch(`${VALIDATE_WORKER_URL.replace(/\/$/, "")}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: body.providerId, key: body.key }),
    });

    const payload = (await upstream.json()) as { valid: boolean; error?: string };
    return Response.json(payload, { status: upstream.status });
  }

  const provider = createProvider(body.providerId);
  const valid = await provider.validateKey(body.key);
  return Response.json({ valid });
}
