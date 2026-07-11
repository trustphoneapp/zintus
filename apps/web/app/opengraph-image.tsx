import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "Zintus — Free AI Router";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0c0c0f 0%, #16161c 100%)",
          color: "#ececef",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ fontSize: 96, fontWeight: 800, color: "#7c92fe", letterSpacing: -2 }}>
          Zintus
        </div>
        <div style={{ fontSize: 40, fontWeight: 600, marginTop: 16, color: "#ececef" }}>
          The open AI router
        </div>
        <div style={{ fontSize: 28, marginTop: 28, color: "#8b8b93" }}>
          12 Free AI Providers · Smart Routing · Zero Markup
        </div>
        <div style={{ fontSize: 22, marginTop: 40, color: "#8b8b93" }}>
          Cerebras · Groq · Gemini · DeepSeek · OpenRouter · +7 more
        </div>
      </div>
    ),
    { ...size },
  );
}
