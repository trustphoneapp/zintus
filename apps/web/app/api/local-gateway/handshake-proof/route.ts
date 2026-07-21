import { issueLocalGatewayHandshakeProof } from "./broker.js";

export async function POST(request: Request): Promise<Response> {
  return issueLocalGatewayHandshakeProof(request);
}
