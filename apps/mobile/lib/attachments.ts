import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

/**
 * Client-side file attachments. Zintus extracts text ON DEVICE and injects it
 * into the prompt as plain text, so files ride the existing string chat schema
 * (the gateway then Tokzen-compresses it server-side). Nothing about the file
 * touches the relay. Binary/opaque formats we can't read on-device (e.g. PDF)
 * are surfaced honestly rather than silently sent as garbage.
 */

export interface Attachment {
  id: string;
  name: string;
  mimeType?: string;
  bytes?: number;
  /** Extracted UTF-8 text, when the file is text-like and within the cap. */
  text?: string;
  /** True when we can't extract text on-device (e.g. PDF, images, binaries). */
  unsupported?: boolean;
  /** True when the file was larger than the cap and the text was truncated. */
  truncated?: boolean;
}

/** Hard cap on extracted characters injected into a prompt (~quota safety). */
const MAX_CHARS = 100_000;

const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|env|tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|scala|sh|bash|zsh|sql|html?|xml|css|scss|less|log|conf|properties|gradle|dockerfile|gitignore)$/i;

function isTextLike(name: string, mimeType?: string): boolean {
  if (TEXT_EXT.test(name)) return true;
  if (!mimeType) return false;
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/x-yaml" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

function newId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Open the system document picker and, for text-like files, extract the text.
 * Returns null when the user cancels. Never throws for an unreadable file —
 * it returns an Attachment flagged `unsupported` so the UI can explain.
 */
export async function pickTextFile(): Promise<Attachment | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.[0]) {
    return null;
  }
  const asset = result.assets[0];
  const base: Attachment = {
    id: newId(),
    name: asset.name,
    mimeType: asset.mimeType,
    bytes: asset.size,
  };

  if (!isTextLike(asset.name, asset.mimeType)) {
    return { ...base, unsupported: true };
  }

  try {
    const raw = await new File(asset.uri).text();
    const truncated = raw.length > MAX_CHARS;
    return { ...base, text: truncated ? raw.slice(0, MAX_CHARS) : raw, truncated };
  } catch {
    return { ...base, unsupported: true };
  }
}

/**
 * Compose the prompt actually sent to the gateway: the typed message followed
 * by labelled blocks of each attachment's extracted text. Unsupported files are
 * noted by name so the model knows they exist but weren't readable.
 */
export function composeMessage(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;
  const blocks = attachments
    .map((a) =>
      a.text
        ? `--- Attached file: ${a.name} ---\n${a.text}`
        : `--- Attached file: ${a.name} (could not extract text on-device) ---`,
    )
    .join("\n\n");
  return text ? `${text}\n\n${blocks}` : blocks;
}
