import { offset } from "../../shared/clock.ts";
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

Deno.test("offset - no clock difference", () => {
  // Symmetric case: no offset, 100ms delay each way
  const timeSentClient = new Date(1000); // T1
  const timeRcvdHost = new Date(1100);   // T2
  const timeSentHost = new Date(1100);   // T3
  const timeRcvdClient = new Date(1200); // T4
  const result = offset(timeSentClient, timeRcvdHost, timeSentHost, timeRcvdClient);
  assertEquals(result, 0);
});

Deno.test("offset - client ahead by 50ms", () => {
  // Client clock ahead by 50ms, 100ms delay each way
  const timeSentClient = new Date(1000); // T1
  const timeRcvdHost = new Date(1050);   // T2
  const timeSentHost = new Date(1050);   // T3
  const timeRcvdClient = new Date(1200); // T4
  const result = offset(timeSentClient, timeRcvdHost, timeSentHost, timeRcvdClient);
  assertEquals(result, -50); // Negative offset means client is ahead (server behind)
});

Deno.test("offset - client behind by 50ms", () => {
  // Client clock behind by 50ms, 100ms delay each way
  const timeSentClient = new Date(1000); // T1
  const timeRcvdHost = new Date(1150);   // T2
  const timeSentHost = new Date(1150);   // T3
  const timeRcvdClient = new Date(1200); // T4
  const result = offset(timeSentClient, timeRcvdHost, timeSentHost, timeRcvdClient);
  assertEquals(result, 50); // Positive offset means client is behind (server ahead)
});