import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_PARAMS = {
  // Keep these modest for serverless cold starts; adjust if you need stronger cost.
  N: 1 << 15,
  r: 8,
  p: 1,
  keylen: 64
} as const;

function getPepper() {
  return process.env.PASSWORD_PEPPER ?? "";
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const peppered = password + getPepper();
  const hash = scryptSync(peppered, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p
  }).toString("hex");
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  try {
    // Legacy format: salt:hash
    if (stored.includes(":") && !stored.startsWith("scrypt$")) {
      const [salt, hashHex] = stored.split(":");
      if (!salt || !hashHex) return false;
      const candidate = scryptSync(password, salt, 64);
      const existing = Buffer.from(hashHex, "hex");
      if (existing.length !== candidate.length) return false;
      return timingSafeEqual(candidate, existing);
    }

    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = parts[4];
    const hashHex = parts[5];
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    if (!salt || !hashHex) return false;

    const peppered = password + getPepper();
    const candidate = scryptSync(peppered, salt, 64, { N, r, p });
    const existing = Buffer.from(hashHex, "hex");
    if (existing.length !== candidate.length) return false;
    return timingSafeEqual(candidate, existing);
  } catch {
    return false;
  }
}

export function hashVerificationCode(code: string, email: string) {
  const secret = process.env.VERIFICATION_CODE_SECRET ?? process.env.SESSION_SECRET ?? "dev-secret";
  const normalizedEmail = email.trim().toLowerCase();
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256")
    .update(secret)
    .update("\n")
    .update(normalizedEmail)
    .update("\n")
    .update(salt)
    .update("\n")
    .update(code)
    .digest("hex");
  return { salt, hash };
}

export function verifyVerificationCode(
  code: string,
  email: string,
  stored: { salt: string; hash: string }
) {
  try {
    const secret = process.env.VERIFICATION_CODE_SECRET ?? process.env.SESSION_SECRET ?? "dev-secret";
    const normalizedEmail = email.trim().toLowerCase();
    const candidateHex = createHash("sha256")
      .update(secret)
      .update("\n")
      .update(normalizedEmail)
      .update("\n")
      .update(stored.salt)
      .update("\n")
      .update(code)
      .digest("hex");
    const candidate = Buffer.from(candidateHex, "hex");
    const existing = Buffer.from(stored.hash, "hex");
    if (candidate.length !== existing.length) return false;
    return timingSafeEqual(candidate, existing);
  } catch {
    return false;
  }
}
