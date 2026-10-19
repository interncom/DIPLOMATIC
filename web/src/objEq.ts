// JSON equality for plain objects.

// Returns whether both values stringify to the same JSON.
// Non-objects, null, and values that cannot be stringified compare unequal.
export function objEq(a: unknown, b: unknown): boolean {
  if (
    a === null || b === null || typeof a !== "object" || typeof b !== "object"
  ) {
    return false;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
