# File & Image Ingestion — Gap Analysis + Plan (2026-07-14)

Trigger: user attached a macOS HEIC screenshot → composer rejected it
("image/heic isn't supported — use PNG, JPEG, or WebP"). Directive: accept all
common formats the way top AI chat products do — normalize, don't reject.

## Research findings (primary-source docs; ⚠ = source read but adversarial
## verification incomplete — re-verify exact numbers at implementation time)

**What the model APIs accept (the floor we must normalize DOWN to):**
- Anthropic API: JPEG/PNG/GIF/WebP ONLY (confirmed). No HEIC/AVIF/TIFF/BMP/SVG.
  Animated GIF → first frame. ⚠ auto-downscale ~1568px long edge (2576px on
  hi-res models), ~10MB/image, 8000×8000 max.
- OpenAI API: ⚠ PNG/JPEG/WebP/non-animated GIF; server auto-downscales
  (2048×2048 fit, 768px short side, 512px tiles / patch-based `detail` param).
- Gemini API: ⚠ natively accepts HEIC/HEIF + PNG/JPEG/WebP inline (20MB request
  cap); auto-downscales to 3072×3072; 768px tiling at 258 tok/tile. (Firebase
  AI Logic wrapper lists only PNG/JPEG/WebP.)

**What the products accept in the composer:**
- Claude.ai images = exactly the API's 4 formats — they REJECT HEIC (no
  conversion layer; confirmed). Documents: PDF, DOCX, CSV, TXT, HTML, ODT, RTF,
  EPUB, JSON, XLSX (XLSX behind code-execution setting); non-PDF docs are
  text-extraction only (confirmed). PDFs get native vision under 100 pages
  (confirmed).
- ChatGPT: "all common extensions" for text/spreadsheet/presentation/document
  (no whitelist; confirmed). 512MB/file hard cap, 2M tokens/text file,
  ~50MB CSV, 20MB/image (confirmed). Docs are text-extraction only on all
  plans except Enterprise (visual PDF retrieval is Enterprise-only; confirmed).
- Claude API PDF path is a server-side hybrid: each page rasterized + text
  extracted, both fed to the model ⚠. Gemini PDF likewise native vision,
  50MB/1000 pages ⚠.
- HEIC in the browser: no Chrome/Firefox native decode; heic-to / libheif-wasm
  converts client-side (Safari decodes natively via createImageBitmap).

**Takeaway:** even Claude.ai rejects HEIC — accepting-and-converting puts us
AHEAD of the field, and ChatGPT's accept-anything document posture is the bar
for text files. The winning pipeline: accept broadly → sniff bytes → normalize
client-side to the JPEG/PNG/WebP floor → honest error only for what genuinely
can't be read.

## Our current state (apps/web + packages/media, audited)

- Images: strict gate jpeg/png/webp (`ACCEPTED_IMAGE_MIMES`), magic-byte
  sniffed, then a REAL normalize pipeline that already exists —
  createImageBitmap → OffscreenCanvas downscale (≤2048px) → re-encode
  (EXIF stripped), 15MB in / 4MB out, 4 images/turn. Rejected: HEIC/HEIF, GIF,
  AVIF, BMP, TIFF, SVG.
- PDF: pdf.js client-side TEXT extraction only (honest fail on scanned pages);
  no native-PDF pass-through even for providers whose APIs take PDFs.
- Text/code: hardcoded 14-extension whitelist. Missing: **.csv**(!), .html,
  .xml, .sql, .log, .java, .c/.cpp/.h, .rb, .php, .swift, .kt, .ini/.cfg/.env,
  .rtf and ~anything else. No content-sniff fallback.
- Office: DOCX/XLSX/PPTX — nothing.
- Audio/video/archives: nothing (mic STT separately deferred — see
  zintus-voice-mic-plan).
- Managed (membership) path: text-only, images blocked pre-send.
- `<input accept=…>` mirrors the same narrow list, so the picker filters out
  everything above before handleFiles even runs. Drag-drop and paste share
  handleFiles — one fix covers all three entry points.

## Plan

**P0 — images: normalize, don't reject (the reported bug)**
1. Gate becomes accept-any `image/*` (+ .heic/.heif extension fallback — macOS
   drag often supplies empty MIME). Magic-byte sniff routes:
   - jpeg/png/webp → existing pipeline unchanged.
   - GIF/BMP/AVIF → createImageBitmap decodes natively in modern engines →
     existing downscale/re-encode path (GIF = first frame, matching Anthropic).
   - HEIC/HEIF → try createImageBitmap (Safari succeeds); on failure lazy
     dynamic-import a wasm decoder (heic-to) → decode → same re-encode path.
     Bundle cost only paid when a HEIC actually arrives.
   - TIFF → v1 honest error (rare; utif later if asked). SVG → keep rejecting
     (scripting attack surface, deliberate).
   Output stays jpeg (quality ladder) — inside every provider's accepted set.
2. Raise input cap 15MB → 20MB (ChatGPT parity); keep 4MB output/4-per-turn.
3. Set `imageOrientation: "from-image"` on createImageBitmap so EXIF-rotated
   photos land upright after the strip.
4. Error copy only for true failures: "Couldn't read this image — it may be
   corrupted" (never a format lecture for a convertible format).

**P1 — documents: match the Claude.ai whitelist, beat it where cheap**
5. TEXT_EXTENSIONS → ~40 entries (csv/tsv/html/xml/sql/log/rtf-as-text +
   mainstream code exts) PLUS a sniff fallback: unknown extension whose first
   64KB decodes as valid UTF-8 → accept as text (ChatGPT posture), with a
   size cap + truncation notice reusing the PDF pattern.
6. DOCX via lazy mammoth (or minimal unzip+document.xml pull) → text fold-in.
   XLSX/CSV via lazy SheetJS → markdown table (small sheets) / CSV text, with
   honest truncation. PPTX = slide text pull (same unzip approach). All
   client-side; bytes never leave the browser (matches our PDF stance).
7. Composer accept= attr + drop/paste hints updated to the widened set.

**P2 — provider-native documents + platform (needs gateway/relay work)**
8. Native PDF pass-through as `document` blocks for providers whose APIs take
   PDFs (Anthropic, Gemini) — full chart/diagram understanding instead of
   text-only extraction. Requires gateway schema + provider adapters; spec
   separately.
9. Managed-path images: relay vision models exist (gemini-2.5-flash,
   gpt-4o-mini, haiku); lift the text-only block behind a relay capability
   check. Separate slice with metering implications.
10. Audio voice-notes → gateway /v1/transcribe (already-deferred mic plan).

Out of scope, stated honestly in UI copy: video files, ZIP archives, scanned-
PDF OCR, SVG.

**Test/verify bar:** unit tests per new sniff/convert branch; fixture files for
heic/gif/bmp/avif/csv/docx/xlsx; scripted-browser attach probe per format;
re-verify the ⚠ caps against provider docs before hardcoding any number.
