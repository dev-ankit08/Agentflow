import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretStore, maskSecret } from "../src";

const key = randomBytes(32).toString("base64");

describe("SecretStore", () => {
  it("round-trips a secret", () => {
    const store = createSecretStore(key);
    const sealed = store.encrypt("sk-ant-123456");
    expect(sealed).not.toContain("sk-ant");
    expect(store.decrypt(sealed)).toBe("sk-ant-123456");
  });

  it("uses a fresh IV each time", () => {
    const store = createSecretStore(key);
    expect(store.encrypt("same")).not.toBe(store.encrypt("same"));
  });

  it("rejects tampered ciphertext and wrong keys", () => {
    const store = createSecretStore(key);
    const sealed = store.encrypt("secret");
    const parts = sealed.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => store.decrypt(parts.join(":"))).toThrow();
    expect(() => createSecretStore(randomBytes(32).toString("base64")).decrypt(sealed)).toThrow();
  });

  it("validates the master key", () => {
    expect(() => createSecretStore(undefined)).toThrow(/not set/);
    expect(() => createSecretStore(Buffer.from("short").toString("base64"))).toThrow(/32 bytes/);
  });

  it("masks secrets", () => {
    expect(maskSecret("sk-abcdef1234")).toBe("••••1234");
    expect(maskSecret("abc")).toBe("••••");
  });
});
