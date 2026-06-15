const DEFAULT_VALIDATE_URL = "http://127.0.0.1:8787/validate";

export function getValidateWorkerUrl(): string {
  return (
    process.env.WORKER_VALIDATE_URL ??
    process.env.VALIDATE_WORKER_URL ??
    DEFAULT_VALIDATE_URL
  );
}

export async function proxyJsonPost(
  targetUrl: string,
  request: Request,
): Promise<Response> {
  const body = await request.text();
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
    },
  });
}
