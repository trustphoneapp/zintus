export function accountSlug(displayName: string): string {
  return displayName.trim().replace(/\s+/g, "-");
}
