import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts secrets at rest. The prototype uses AES-256-GCM with a key from the environment;
 * a KMS-backed implementation can replace it later behind the same interface.
 */
export interface SecretStore {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

const VERSION = "v1";

export function parseMasterKey(base64: string | undefined): Buffer {
  if (!base64) throw new Error("SECRETS_MASTER_KEY is not set (32 bytes, base64)");
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error(`SECRETS_MASTER_KEY must decode to 32 bytes (got ${key.length})`);
  return key;
}

export function createSecretStore(masterKeyBase64: string | undefined): SecretStore {
  const key = parseMasterKey(masterKeyBase64);
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
    },
    decrypt(ciphertext) {
      const [version, iv, tag, data] = ciphertext.split(":");
      if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unrecognised secret format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    },
  };
}

/** Shows only the last 4 characters, for listing stored keys. */
export function maskSecret(plaintext: string): string {
  return plaintext.length <= 4 ? "••••" : `••••${plaintext.slice(-4)}`;
}
