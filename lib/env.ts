/**
 * Single source of truth for the JWT signing secrets.
 *
 * These used to be read as `process.env.JWT_SECRET || "vivo123"` at five
 * different call sites. A missing env var therefore didn't fail - it silently
 * signed every token with a secret that's committed in the git history, so
 * anyone who read the repo could forge a token for any user id.
 *
 * Read them through here instead. Getters are lazy so importing this module is
 * side-effect free (tests don't need the env set); `assertJwtSecrets()` runs at
 * boot so a misconfigured deploy dies immediately with a clear message instead
 * of serving forgeable tokens.
 */

function required(name: "JWT_SECRET" | "JWT_REFRESH_SECRET"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Refusing to sign or verify tokens without it - ` +
        `set it in the environment (see .env.example) and restart.`,
    );
  }
  return value;
}

export const jwtSecret = () => required("JWT_SECRET");
export const jwtRefreshSecret = () => required("JWT_REFRESH_SECRET");

/** Call once at startup so a missing secret is a boot failure, not a runtime surprise. */
export function assertJwtSecrets(): void {
  jwtSecret();
  jwtRefreshSecret();
}
