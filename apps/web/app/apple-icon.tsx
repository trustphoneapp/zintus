import { ImageResponse } from "next/og";

// Next.js App Router generated apple-touch-icon (file convention: app/apple-icon).
// https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons
//
// PLACEHOLDER Zintus mark — the same minimal geometric "Z" on brand violet as
// app/icon.svg. It is a stand-in pending the real brand asset. [HUMAN] when the
// final logo exists, drop a static `app/apple-icon.png` (180×180) in to replace
// this generated route.
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
          <path
            d="M168 176H344L168 336H344"
            stroke="#FFFFFF"
            strokeWidth="48"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
