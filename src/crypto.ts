import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const randomToken = () => randomBytes(32).toString("base64url");
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const pkce = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
