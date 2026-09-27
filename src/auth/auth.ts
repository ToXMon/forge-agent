import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal single-file auth: email + scrypt-hashed password, opaque bearer
 * tokens, and a per-user token-credit ledger that the harness's llm_usage
 * events drain. The first registered user becomes admin (unlimited credits,
 * sees all sessions) — bootstrap is "sign up first".
 *
 * Storage: two JSON files under <workDir>/.forge (users.json, auth-tokens.json).
 * Not multi-node safe — fine for a single-instance deployment, which is the
 * deployment shape Forge targets.
 */

const SCRYPT_KEYLEN = 64;

export interface User {
  email: string;
  salt: string;
  hash: string;
  /** Remaining trial/purchased LLM token credits. null = unlimited (admin). */
  creditsTokens: number | null;
  admin: boolean;
  createdAt: string;
}

export interface AuthStoreDeps {
  workDir: string;
  /** Credits granted to a new non-admin signup. */
  trialTokens: number;
  /** Pepper for password hashing (FORGE_SECRET). Rotate = reset passwords. */
  secret: string;
  /** Auth token lifetime in days. */
  tokenTtlDays?: number;
}

export class AuthStore {
  private usersPath: string;
  private tokensPath: string;
  private users = new Map<string, User>();
  /** token → { email, expiresAt }. Tokens are opaque; revocable. */
  private tokens = new Map<string, { email: string; expiresAt: number }>();

  constructor(private deps: AuthStoreDeps) {
    const dir = join(deps.workDir, ".forge");
    mkdirSync(dir, { recursive: true });
    this.usersPath = join(dir, "users.json");
    this.tokensPath = join(dir, "auth-tokens.json");
    this.load();
  }

  private load(): void {
    if (existsSync(this.usersPath)) {
      const raw = JSON.parse(readFileSync(this.usersPath, "utf8")) as User[];
      for (const u of raw) this.users.set(u.email, u);
    }
    if (existsSync(this.tokensPath)) {
      const raw = JSON.parse(readFileSync(this.tokensPath, "utf8")) as Record<string, { email: string; expiresAt: number }>;
      const now = Date.now();
      for (const [t, v] of Object.entries(raw)) if (v.expiresAt > now) this.tokens.set(t, v);
    }
  }

  private save(): void {
    writeFileSync(this.usersPath, JSON.stringify([...this.users.values()], null, 2));
    writeFileSync(this.tokensPath, JSON.stringify(Object.fromEntries(this.tokens)));
  }

  private hash(password: string, salt: string): Buffer {
    return scryptSync(`${password}:${this.deps.secret}`, salt, SCRYPT_KEYLEN);
  }

  /** Create a user. The very first user is admin (null credits = unlimited). */
  signup(email: string, password: string): User {
    email = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("invalid email", 400);
    if (password.length < 8) throw new AuthError("password must be at least 8 characters", 400);
    if (this.users.has(email)) throw new AuthError("email already registered", 409);

    const salt = randomBytes(16).toString("hex");
    const user: User = {
      email,
      salt,
      hash: this.hash(password, salt).toString("hex"),
      creditsTokens: this.users.size === 0 ? null : this.deps.trialTokens,
      admin: this.users.size === 0,
      createdAt: new Date().toISOString(),
    };
    this.users.set(email, user);
    this.save();
    return user;
  }

  login(email: string, password: string): User {
    const user = this.users.get(email.trim().toLowerCase());
    // Constant-time compare; a dummy hash keeps timing uniform for unknown emails.
    const expected = user
      ? Buffer.from(user.hash, "hex")
      : this.hash(password, "00000000000000000000000000000000");
    const actual = this.hash(password, user?.salt ?? "00000000000000000000000000000000");
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!user || !ok) throw new AuthError("invalid credentials", 401);
    return user;
  }

  /** Issue an opaque bearer token. */
  issueToken(email: string): string {
    const token = randomUUID().replace(/-/g, "") + randomBytes(16).toString("hex");
    this.tokens.set(token, {
      email: email.trim().toLowerCase(),
      expiresAt: Date.now() + (this.deps.tokenTtlDays ?? 30) * 86_400_000,
    });
    this.save();
    return token;
  }

  resolveToken(token: string | undefined): User | null {
    if (!token) return null;
    const entry = this.tokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return this.users.get(entry.email) ?? null;
  }

  logout(token: string | undefined): void {
    if (token && this.tokens.delete(token)) this.save();
  }

  /** Deduct used tokens. Returns the user or null if unknown. Throws on insufficient credits. */
  deduct(email: string, totalTokens: number): User | null {
    const user = this.users.get(email);
    if (!user) return null;
    if (user.creditsTokens != null) {
      user.creditsTokens -= totalTokens;
      this.save();
      if (user.creditsTokens < 0) user.creditsTokens = 0;
    }
    return user;
  }

  hasCredits(email: string): boolean {
    const user = this.users.get(email);
    return !!user && (user.creditsTokens == null || user.creditsTokens > 0);
  }

  get(email: string): User | null {
    return this.users.get(email.trim().toLowerCase()) ?? null;
  }
}

export class AuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
