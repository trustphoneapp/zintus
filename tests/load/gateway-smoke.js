import http from "k6/http";
import { check, sleep } from "k6";

// Load smoke for the gateway's public /health endpoint (no auth, keyless).
// Proves the gateway stays responsive and error-free under modest concurrency.
// Thresholds fail the CI step if violated.
export const options = {
  vus: 5, // 5 virtual users
  duration: "30s",
  thresholds: {
    http_req_failed: ["rate<0.05"], // <5% errors
    http_req_duration: ["p(95)<2000"], // 95th percentile under 2s
  },
};

const GATEWAY_URL = __ENV.GATEWAY_URL || "http://localhost:8788";

export default function () {
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
