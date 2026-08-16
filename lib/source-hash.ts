export async function blobSha256(blob: Blob): Promise<string> {
  const buffer = await blob.slice(0, blob.size, blob.type).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
