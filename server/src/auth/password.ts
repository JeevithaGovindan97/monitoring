import { hash, verify } from '@node-rs/argon2';
import crypto from 'node:crypto';

// Argon2id (algorithm 2) with OWASP-recommended parameters.
const OPTS = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw: string) => hash(pw, OPTS);
export async function verifyPassword(hashed: string, pw: string) {
  try {
    return await verify(hashed, pw);
  } catch {
    return false;
  }
}

export function passwordProblems(pw: string): string | null {
  if (pw.length < 12) return 'Password must be at least 12 characters';
  if (pw.length > 200) return 'Password is too long';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain upper-case, lower-case and a digit';
  return null;
}

export function generatePassword(): string {
  const bytes = crypto.randomBytes(18).toString('base64url');
  return `Aa1-${bytes}`;
}

// Used to keep login timing similar for unknown users (hash computed once, lazily).
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword('not-a-real-password-Aa1'));
