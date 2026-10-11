import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  getAuthSecret,
  createSessionToken,
  verifySessionToken,
  DEFAULT_DEV_AUTH_SECRET,
  EXAMPLE_ENV_AUTH_SECRET,
  MIN_AUTH_SECRET_BYTES,
} from '@/lib/auth/session';

describe('Production AUTH_SECRET Hardening and Session Validation Suite', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAuthSecret = process.env.AUTH_SECRET;

  function setNodeEnv(val: string | undefined): void {
    if (val === undefined) {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    } else {
      (process.env as Record<string, string | undefined>).NODE_ENV = val;
    }
  }

  function setAuthSecret(val: string | undefined): void {
    if (val === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = val;
    }
  }

  beforeEach(() => {
    // Restore baseline before each test
    setNodeEnv(originalNodeEnv);
    setAuthSecret(originalAuthSecret);
  });

  afterEach(() => {
    // Guaranteed restoration even after unexpected test failure
    setNodeEnv(originalNodeEnv);
    setAuthSecret(originalAuthSecret);
  });

  it('1. Rejects missing, empty, or whitespace-only AUTH_SECRET in production', () => {
    setNodeEnv('production');

    // Case 1a: completely undefined
    setAuthSecret(undefined);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*AUTH_SECRET must be explicitly configured in production/i);
    expect(() => createSessionToken('user-100')).toThrowError(/SECURITY VIOLATION/i);

    // Case 1b: empty string
    setAuthSecret('');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*AUTH_SECRET must be explicitly configured in production/i);
    expect(() => createSessionToken('user-100')).toThrowError(/SECURITY VIOLATION/i);

    // Case 1c: whitespace only
    setAuthSecret('   \t  ');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*AUTH_SECRET must be explicitly configured in production/i);
    expect(() => createSessionToken('user-100')).toThrowError(/SECURITY VIOLATION/i);
  });

  it('2. Rejects the built-in development secret in production', () => {
    setNodeEnv('production');
    setAuthSecret(DEFAULT_DEV_AUTH_SECRET);

    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*AUTH_SECRET cannot use default, placeholder, or example secrets/i);
    expect(() => createSessionToken('user-200')).toThrowError(/SECURITY VIOLATION/i);
  });

  it('3. Rejects short secrets such as "secret" in production', () => {
    setNodeEnv('production');

    // Case 3a: "secret"
    setAuthSecret('secret');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION/i);
    expect(() => createSessionToken('user-300')).toThrowError(/SECURITY VIOLATION/i);

    // Case 3b: 16 characters
    setAuthSecret('short-16-bytes!');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*must be at least 32 bytes/i);

    // Case 3c: 31 characters (exactly 1 byte under the 32-byte threshold)
    const exactly31Bytes = 'a'.repeat(31);
    expect(Buffer.byteLength(exactly31Bytes, 'utf8')).toBe(31);
    setAuthSecret(exactly31Bytes);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*must be at least 32 bytes/i);
  });

  it('4. Rejects example placeholder secrets and variants in production', () => {
    setNodeEnv('production');

    // Case 4a: EXAMPLE_ENV_AUTH_SECRET from .env.example
    setAuthSecret(EXAMPLE_ENV_AUTH_SECRET);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*cannot use default, placeholder, or example secrets/i);
    expect(() => createSessionToken('user-400')).toThrowError(/SECURITY VIOLATION/i);

    // Case 4b: custom string containing 'change-in-production'
    setAuthSecret('my-long-production-key-change-in-production-long-enough-32bytes');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*cannot use default, placeholder, or example secrets/i);

    // Case 4c: string containing 'change-this-in-production'
    setAuthSecret('custom-key-change-this-in-production-over-thirty-two-bytes');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*cannot use default, placeholder, or example secrets/i);

    // Case 4d: string containing 'placeholder'
    setAuthSecret('placeholder-key-for-auth-secret-longer-than-32-bytes-test');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*cannot use default, placeholder, or example secrets/i);
  });

  it('5. Allows token creation and verification with a sufficiently long configured secret in production', () => {
    setNodeEnv('production');

    // Case 5a: Standard base64-encoded 32-byte random key (openssl rand -base64 32 produces 44 chars)
    const base64Secret = crypto.randomBytes(32).toString('base64');
    expect(Buffer.byteLength(base64Secret, 'utf8')).toBeGreaterThanOrEqual(MIN_AUTH_SECRET_BYTES);
    setAuthSecret(base64Secret);

    expect(getAuthSecret()).toBe(base64Secret);

    const userId = 'usr_prod_verified_999';
    const token = createSessionToken(userId);
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');

    const verifiedUserId = verifySessionToken(token);
    expect(verifiedUserId).toBe(userId);

    // Case 5b: Exactly 32 bytes UTF-8 ASCII key
    const exact32Secret = 'k9#mP2$xL7!vQ4@wR8*yN1&zT5^bC6(d';
    expect(Buffer.byteLength(exact32Secret, 'utf8')).toBe(32);
    setAuthSecret(exact32Secret);

    expect(getAuthSecret()).toBe(exact32Secret);

    const token2 = createSessionToken(userId);
    expect(verifySessionToken(token2)).toBe(userId);
  });

  it('6. Invalid production configuration cannot silently fall back to the development secret (fails closed)', () => {
    // Generate a valid token in development using the default dev secret
    setNodeEnv('development');
    setAuthSecret(undefined);
    const devToken = createSessionToken('alice_dev_user');
    expect(verifySessionToken(devToken)).toBe('alice_dev_user');

    // Switch to production
    setNodeEnv('production');

    // Subcase 6a: Missing production secret must NOT fall back to dev secret
    setAuthSecret(undefined);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION/i);
    expect(() => createSessionToken('bob_prod_user')).toThrowError(/SECURITY VIOLATION/i);
    // verifySessionToken must catch the failure and fail closed (return null, NEVER accept devToken)
    expect(verifySessionToken(devToken)).toBeNull();

    // Subcase 6b: Weak/short secret in production must NOT fall back to dev secret
    setAuthSecret('secret');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION/i);
    expect(verifySessionToken(devToken)).toBeNull();

    // Subcase 6c: Example placeholder secret in production must NOT fall back to dev secret
    setAuthSecret(EXAMPLE_ENV_AUTH_SECRET);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION/i);
    expect(verifySessionToken(devToken)).toBeNull();

    // Subcase 6d: Even when production has a valid strong secret, devToken signed by dev secret must be rejected
    setAuthSecret(crypto.randomBytes(32).toString('base64'));
    expect(verifySessionToken(devToken)).toBeNull();
  });

  it('7. Preserves functional zero-config local development and test workflows', () => {
    // In development mode with no secret configured
    setNodeEnv('development');
    setAuthSecret(undefined);

    expect(getAuthSecret()).toBe(DEFAULT_DEV_AUTH_SECRET);
    const devUser = 'local_developer_42';
    const devToken = createSessionToken(devUser);
    expect(verifySessionToken(devToken)).toBe(devUser);

    // In development mode with custom dev secret (even a short one)
    setAuthSecret('local-custom-dev-key');
    expect(getAuthSecret()).toBe('local-custom-dev-key');
    const customDevToken = createSessionToken(devUser);
    expect(verifySessionToken(customDevToken)).toBe(devUser);

    // In test mode (NODE_ENV=test)
    setNodeEnv('test');
    setAuthSecret(undefined);
    expect(getAuthSecret()).toBe(DEFAULT_DEV_AUTH_SECRET);
    const testToken = createSessionToken(devUser);
    expect(verifySessionToken(testToken)).toBe(devUser);
  });

  it('8. Does NOT leak secret values or substrings in error messages', () => {
    setNodeEnv('production');
    const confidentialWeakSecret = 'unauthorized-short-secret-value';
    setAuthSecret(confidentialWeakSecret);

    try {
      getAuthSecret();
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('SECURITY VIOLATION');
      // Ensure the actual secret value is NEVER included in the error message
      expect(err.message).not.toContain(confidentialWeakSecret);
      expect(err.message).not.toContain('unauthorized-short-secret-value');
    }
  });
});
