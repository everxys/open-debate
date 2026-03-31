import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const DEV_FALLBACK_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function isProductionEnvironment() {
  return process.env.NODE_ENV === "production";
}

/** Derive 256-bit key from env. Only local/dev environments may use the fallback key. */
function getEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY?.trim() || null;
  if (!raw) {
    if (isProductionEnvironment()) {
      throw new Error("ENCRYPTION_KEY must be set in production");
    }
    return createHash("sha256").update(DEV_FALLBACK_ENCRYPTION_KEY).digest();
  }
  return createHash("sha256").update(raw).digest();
}

/** Encrypt secret with AES-256-GCM, return hex-encoded iv:tag:ciphertext */
export function encryptSecret(value: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/** Decrypt secret from hex-encoded iv:tag:ciphertext format */
export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, ciphertextHex] = payload.split(":");
  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}

/** Mask secret for display: show prefix and suffix with ellipsis */
export function maskSecret(value: string): string {
  if (!value) return "***";
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
