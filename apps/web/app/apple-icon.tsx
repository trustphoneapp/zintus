import { ImageResponse } from "next/og";

// Next.js App Router generated apple-touch-icon (file convention: app/apple-icon).
// https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons
//
// Zintus apple-touch-icon — the networked "Z" brand mark, matching app/icon.svg
// and components/ZintusLogo.tsx (no longer a divergent placeholder). A final
// designer-delivered static `app/apple-icon.png` (180×180) can still drop in over
// this generated route later.
//
// Generated via next/og's ImageResponse (same approach as app/opengraph-image.tsx)
// because no raster/PNG tooling is available in this environment to hand-author a
// real .png. The route emits a real PNG at request/build time.

export const runtime = "nodejs";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // Full-bleed square; iOS rounds the corners itself.
          background: "linear-gradient(135deg, #7C3AED 0%, #4C1D95 100%)",
        }}
      >
        <svg width="116" height="116" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Z strokes: top -> diagonal -> bottom (single path for Satori) */}
          <path
            d="M112 128 L400 128 L112 384 L400 384"
            stroke="#FFFFFF"
            strokeWidth="38"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Dimmer midpoint nodes */}
          <circle cx="312" cy="213" r="22" fill="#C4B5FD" />
          <circle cx="200" cy="299" r="22" fill="#C4B5FD" />
          {/* Corner node endpoints */}
          <circle cx="112" cy="128" r="38" fill="#FFFFFF" />
          <circle cx="400" cy="128" r="38" fill="#FFFFFF" />
          <circle cx="112" cy="384" r="38" fill="#FFFFFF" />
          <circle cx="400" cy="384" r="38" fill="#FFFFFF" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
