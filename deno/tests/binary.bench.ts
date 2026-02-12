import { btoh, htob, btob128, b128tob } from "../../shared/binary.ts";

function uint8ToBinaryString(uint8: Uint8Array): string {
  return Array.from(uint8, byte => String.fromCharCode(byte)).join('');
}

function binaryStringToUint8(str: string): Uint8Array {
  return new Uint8Array([...str].map(c => c.charCodeAt(0)));
}

const sizes = [100, 1000, 10000, 50000];

const testData: Uint8Array[] = sizes.map(size => {
  const arr = new Uint8Array(size);
  crypto.getRandomValues(arr);
  return arr;
});

for (let i = 0; i < sizes.length; i++) {
  const size = sizes[i];
  const bytes = testData[i];

  Deno.bench(`base64 roundtrip ${size} bytes`, () => {
    const binStr = uint8ToBinaryString(bytes);
    const encoded = btoa(binStr);
    const decodedBin = atob(encoded);
    const decoded = binaryStringToUint8(decodedBin);
  });

  Deno.bench(`hex roundtrip ${size} bytes`, () => {
    const encoded = btoh(bytes);
    const decoded = htob(encoded);
  });

  Deno.bench(`base128 roundtrip ${size} bytes`, () => {
    const encoded = btob128(bytes);
    const decoded = b128tob(encoded);
  });
}