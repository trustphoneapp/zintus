import http from "k6/http";
import { check, sleep } from "k6";

// Load smoke for the gateway. Two scenarios run concurrently:
//   * health — the public, keyless /health probe (must stay ~perfect).
//   * chat   — POST /v1/chat/completions, the real request path (auth, zod
//              body validation, routing). In CI there are no provider keys, so
//              the router returns a STRUCTURED error rather than a completion —
//              we therefore gate the chat path on latency + "the server
//              responded with structured JSON and didn't hang/crash", not on a
//              2xx. The failure this guards against is the handler hanging,
//              dropping the connection, or crashing the process under load.
const GATEWAY_URL = __ENV.GATEWAY_URL || "http://localhost:8788";

export const options = {
  scenarios: {
    health: {
      executor: "constant-vus",
      vus: 5,
      duration: "30s",
      exec: "health",
      tags: { scenario: "health" },
    },
    chat: {
      executor: "constant-vus",
      vus: 3,
      duration: "30s",
      exec: "chat",
      tags: { scenario: "chat" },
    },
  },
  thresholds: {
    // Health: near-perfect under modest concurrency.
    "http_req_failed{scenario:health}": ["rate<0.05"],
    "http_req_duration{scenario:health}": ["p(95)<2000"],
    // Chat: the handler must respond promptly without hanging. Lenient p95
    // because a real provider call (when keys exist) is slower; the point is
    // "no hangs/crashes under load". Not gated on 2xx (see header note).
    "http_req_duration{scenario:chat}": ["p(95)<5000"],
    "checks{scenario:chat}": ["rate>0.95"],
  },
};

const CHAT_BODY = JSON.stringify({
  model: "auto",
  messages: [{ role: "user", content: "ping" }],
  stream: false,
});

export function health() {
  const res = http.get(`${GATEWAY_URL}/health`);
  check(res, {
    "health returns 200": (r) => r.status === 200,
    "body has ok:true": (r) => {
      try {
        return JSON.parse(r.body).ok === true;
      } catch {
        return false;
      }
    },
  });
  sleep(1);
}

export function chat() {
  const res = http.post(`${GATEWAY_URL}/v1/chat/completions`, CHAT_BODY, {
    headers: { "Content-Type": "application/json" },
  });
  check(res, {
    // status 0 == request never completed (timeout / dropped socket) — the hang
    // we're guarding against. Any HTTP status means the handler responded.
    "chat path responded (not a hang)": (r) => r.status !== 0,
    "chat response is structured JSON": (r) => {
      try {
        JSON.parse(r.body);
        return true;
      } catch {
        return false;
      }
    },
  });
  sleep(1);
}
