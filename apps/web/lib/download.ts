/** Trigger a browser download while keeping the object URL alive through navigation. */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Trigger a browser download of in-memory content. */
export function downloadFile(name: string, content: string, type: string): void {
  downloadBlob(name, new Blob([content], { type }));
}
