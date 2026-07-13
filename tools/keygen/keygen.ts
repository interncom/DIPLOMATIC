const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);

const hex = Array.from(bytes)
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

console.log(hex);
