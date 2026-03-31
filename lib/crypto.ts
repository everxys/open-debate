import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/** Derive 256-bit key from env or fallback (for dev only) */
function getEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
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
