/** Trigger a browser file download for a Blob (main thread only). */
export function saveBlob(blob: Blob, filename: string): void {
  // @ts-expect-error: msSaveOrOpenBlob is non-standard IE/Edge API
  if (typeof navigator.msSaveOrOpenBlob === "function") {
    // @ts-expect-error: msSaveOrOpenBlob is non-standard IE/Edge API
    navigator.msSaveOrOpenBlob(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
