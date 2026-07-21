import { proxyJudgeGatewayRequest } from "@/lib/judge-gateway-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return proxyJudgeGatewayRequest(request, path);
}

export const GET = forward;
export const POST = forward;
