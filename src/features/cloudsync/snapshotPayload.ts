export async function payloadFingerprint(payload: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(payload),
    );
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
  }
  return payload;
}

export async function snapshotPayload(snapshot: unknown) {
  const json = JSON.stringify(snapshot);
  return { body: new Blob([json]), fingerprint: await payloadFingerprint(json) };
}
