import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { CallbackListener } from "../../shared/lpc/listener.ts";
import { CallbackNotifier } from "../../shared/lpc/pusher.ts";
import type { PublicKey } from "../../shared/types.ts";

Deno.test("lpc integration", async (t) => {
  const notifier = new CallbackNotifier();

  await t.step("connect and push", async () => {
    const listener = new CallbackListener(notifier);

    // Mock public key (32 bytes for Ed25519 public key)
    const pubKey = new Uint8Array(32).fill(0xab) as PublicKey;

    let receivedData: Uint8Array | undefined;
    const receiver = (data: Uint8Array) => {
      receivedData = data;
    };

    // Initially not connected
    assertEquals(listener.connected(), false);

    // Connect
    listener.connect(pubKey, receiver);
    assertEquals(listener.connected(), true);

    // Push data
    const testData = new TextEncoder().encode("TEST MESSAGE");
    notifier.push(pubKey, testData);

    // Check that data was received
    assertEquals(receivedData, testData);

    // Disconnect
    listener.disconnect();
    assertEquals(listener.connected(), false);
  });

  await t.step("multiple listeners", async () => {
    const listener1 = new CallbackListener(notifier);
    const listener2 = new CallbackListener(notifier);

    const pubKey = new Uint8Array(32).fill(0xcd) as PublicKey;

    let received1: Uint8Array | undefined;
    let received2: Uint8Array | undefined;

    const receiver1 = (data: Uint8Array) => {
      received1 = data;
    };
    const receiver2 = (data: Uint8Array) => {
      received2 = data;
    };

    // Connect both
    listener1.connect(pubKey, receiver1);
    listener2.connect(pubKey, receiver2);

    // Push data
    const testData = new TextEncoder().encode("MULTI TEST");
    notifier.push(pubKey, testData);

    // Both should receive
    assertEquals(received1, testData);
    assertEquals(received2, testData);

    // Disconnect one and push again
    listener1.disconnect();
    notifier.push(pubKey, new TextEncoder().encode("SECOND TEST"));

    // Only listener2 should have updated
    assertEquals(received1, testData); // Still old
    assertEquals(received2, new TextEncoder().encode("SECOND TEST"));
  });
});
