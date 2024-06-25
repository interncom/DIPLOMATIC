export function btoh(bytes: Uint8Array): string {
  const hex = Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
  return hex;
}

export function htob(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
