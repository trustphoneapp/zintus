/**
 * Pure logic for the chat composer's "Pasted text" chip (Claude.ai parity):
 * a long paste becomes an attachment chip instead of dumping raw text into the
 * textarea. Kept free of React/DOM so the threshold and naming rules are
 * unit-testable directly.
 */

/** Paste chip kicks in above either bound — mirrors Claude.ai's composer. */
export const PASTE_CHAR_THRESHOLD = 2500;
export const PASTE_LINE_THRESHOLD = 50;

/** True when a pasted string is long enough to become a "Pasted text" chip
 *  instead of being inserted inline into the textarea. */
export function shouldChipPaste(text: string): boolean {
  if (text.length > PASTE_CHAR_THRESHOLD) return true;
  const lines = text.split("\n").length;
  return lines > PASTE_LINE_THRESHOLD;
}

/** Name a new paste chip from the names of already-attached chips: "Pasted
 *  text" for the first, "Pasted text 2" / "Pasted text 3" / … after that. */
export function nextPastedTextName(existingNames: string[]): string {
  const count = existingNames.filter((n) => n.startsWith("Pasted text")).length;
  return count === 0 ? "Pasted text" : `Pasted text ${count + 1}`;
}

/** Chip meta line for a paste: "12,439 chars". */
export function formatCharCount(n: number): string {
  return `${n.toLocaleString()} chars`;
}
