// Identity of a source file without reading all of it: SHA-256 of first + last 4 MB + size.

const CHUNK = 4 * 1024 * 1024;

export async function fileKey(file: Blob): Promise<string> {
  const head = await file.slice(0, CHUNK).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - CHUNK)).arrayBuffer();
  const size = new TextEncoder().encode(String(file.size));
  const buf = new Uint8Array(head.byteLength + tail.byteLength + size.byteLength);
  buf.set(new Uint8Array(head), 0);
  buf.set(new Uint8Array(tail), head.byteLength);
  buf.set(size, head.byteLength + tail.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
