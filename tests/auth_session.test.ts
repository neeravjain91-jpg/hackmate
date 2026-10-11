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
    // Guaranteed restoration even after test failures
    setNodeEnv(originalNodeEnv);
    setAuthSecret(originalAuthSecret);
  });

  it('1. Rejects a 32-character repeated-symbol secret in production', () => {
    setNodeEnv('production');

    // Case 1a: repeated exclamation marks (32 symbols)
    const repeatedExclamation = '!'.repeat(32);
    setAuthSecret(repeatedExclamation);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*obvious weak, repeated, or predictable pattern/i);
    expect(() => createSessionToken('user-sym-1')).toThrowError(/SECURITY VIOLATION/i);

    // Case 1b: repeated hash symbols (40 symbols)
    setAuthSecret('#'.repeat(40));
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*obvious weak, repeated, or predictable pattern/i);

    // Case 1c: single repeated alphanumeric character (32 chars)
    setAuthSecret('a'.repeat(32));
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*obvious weak, repeated, or predictable pattern/i);
  });

  it('2. Rejects repeated weak words such as passwordpasswordpasswordpassword in production', () => {
    setNodeEnv('production');

    // Case 2a: "password" repeated 4 times (32 characters)
    setAuthSecret('passwordpasswordpasswordpassword');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*obvious weak, repeated, or predictable pattern/i);
    expect(() => createSessionToken('user-weak-word')).toThrowError(/SECURITY VIOLATION/i);

    // Case 2b: "password" repeated with hyphens
    setAuthSecret('password-password-password-password');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*obvious weak, repeated, or predictable pattern/i);

    // Case 2c: "secret" repeated 6 times (36 characters)
    setAuthSecret('secretsecretsecretsecretsecretsecret');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*obvious weak, repeated, or predictable pattern/i);

    // Case 2d: "admin" repeated 7 times (35 characters)
    setAuthSecret('adminadminadminadminadminadminadmin');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*obvious weak, repeated, or predictable pattern/i);

    // Case 2e: "12345678" repeated 4 times (32 characters)
    setAuthSecret('12345678123456781234567812345678');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*obvious weak, repeated, or predictable pattern/i);
  });

  it('3. Rejects existing short and placeholder secrets in production', () => {
    setNodeEnv('production');

    // Case 3a: missing/empty
    setAuthSecret(undefined);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*AUTH_SECRET must be explicitly configured/i);

    setAuthSecret('');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*AUTH_SECRET must be explicitly configured/i);

    setAuthSecret('   \t  ');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*AUTH_SECRET must be explicitly configured/i);

    // Case 3b: default dev secret
    setAuthSecret(DEFAULT_DEV_AUTH_SECRET);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*cannot use default, placeholder, or example/i);

    // Case 3c: template example secret
    setAuthSecret(EXAMPLE_ENV_AUTH_SECRET);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*cannot use default, placeholder, or example/i);

    // Case 3d: placeholder with 'change-in-production'
    setAuthSecret('my-long-production-key-change-in-production-long-enough-32bytes');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*cannot use default, placeholder, or example/i);

    // Case 3e: short secrets
    setAuthSecret('secret');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*must be at least 32 bytes/i);

    setAuthSecret('short-16-bytes!');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*must be at least 32 bytes/i);

    const exactly31Bytes = 'k9#mP2$xL7!vQ4@wR8*yN1&zT5^bC6(';
    expect(Buffer.byteLength(exactly31Bytes, 'utf8')).toBe(31);
    setAuthSecret(exactly31Bytes);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION.*must be at least 32 bytes/i);
  });

  it('4. Accepts cryptographically random generated secrets without false positives from broad blacklists', () => {
    setNodeEnv('production');

    // Case 4a: 32 bytes random base64 (openssl rand -base64 32 produces 44 chars)
    const base64Secret = crypto.randomBytes(32).toString('base64');
    expect(Buffer.byteLength(base64Secret, 'utf8')).toBeGreaterThanOrEqual(MIN_AUTH_SECRET_BYTES);
    setAuthSecret(base64Secret);
    expect(getAuthSecret()).toBe(base64Secret);

    // Case 4b: 32 bytes random hex (64 chars)
    const hexSecret = crypto.randomBytes(32).toString('hex');
    setAuthSecret(hexSecret);
    expect(getAuthSecret()).toBe(hexSecret);

    // Case 4c: Valid 32-byte high-entropy ASCII secret
    const highEntropyAscii = 'k9#mP2$xL7!vQ4@wR8*yN1&zT5^bC6(d';
    expect(Buffer.byteLength(highEntropyAscii, 'utf8')).toBe(32);
    setAuthSecret(highEntropyAscii);
    expect(getAuthSecret()).toBe(highEntropyAscii);

    // Case 4d: Ensure secret containing the substring "secret" as part of a complex token is NOT rejected
    const secretWithSubword = 'a8F!qZ9#mK2$xL7!vQ4@wR8*yN1&zT5^secret_key_random_token_999';
    expect(Buffer.byteLength(secretWithSubword, 'utf8')).toBeGreaterThanOrEqual(32);
    setAuthSecret(secretWithSubword);
    expect(getAuthSecret()).toBe(secretWithSubword);
  });

  it('5. Allows session creation and verification with a valid production secret', () => {
    setNodeEnv('production');
    const validSecret = crypto.randomBytes(32).toString('base64');
    setAuthSecret(validSecret);

    const userId = 'usr_prod_verified_777';
    const token = createSessionToken(userId);
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');

    const verifiedUserId = verifySessionToken(token);
    expect(verifiedUserId).toBe(userId);
  });

  it('6. Invalid production configuration never falls back to the development secret (fails closed)', () => {
    // Generate a valid dev token using the default dev secret
    setNodeEnv('development');
    setAuthSecret(undefined);
    const devToken = createSessionToken('alice_dev_user');
    expect(verifySessionToken(devToken)).toBe('alice_dev_user');

    // Switch to production
    setNodeEnv('production');

    // Subcase 6a: Missing production secret fails closed
    setAuthSecret(undefined);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION/i);
    expect(() => createSessionToken('bob_prod_user')).toThrowError(/SECURITY VIOLATION/i);
    expect(verifySessionToken(devToken)).toBeNull();

    // Subcase 6b: Weak/short secret fails closed
    setAuthSecret('secret');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION/i);
    expect(verifySessionToken(devToken)).toBeNull();

    // Subcase 6c: Repeated symbol fails closed
    setAuthSecret('!'.repeat(32));
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION/i);
    expect(verifySessionToken(devToken)).toBeNull();

    // Subcase 6d: Repeated weak word fails closed
    setAuthSecret('passwordpasswordpasswordpassword');
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION/i);
    expect(verifySessionToken(devToken)).toBeNull();

    // Subcase 6e: Placeholder secret fails closed
    setAuthSecret(EXAMPLE_ENV_AUTH_SECRET);
    expect(() => getAuthSecret()).toThrowError(/SECURITY VIOLATION/i);
    expect(verifySessionToken(devToken)).toBeNull();

    // Subcase 6f: Valid strong production secret rejects token signed by dev secret
    setAuthSecret(crypto.randomBytes(32).toString('base64'));
    expect(verifySessionToken(devToken)).toBeNull();
  });

  it('7. Preserves functional zero-config local development and test workflows', () => {
    // Development mode with no secret configured
    setNodeEnv('development');
    setAuthSecret(undefined);
    expect(getAuthSecret()).toBe(DEFAULT_DEV_AUTH_SECRET);
    const devUser = 'local_developer_42';
    const devToken = createSessionToken(devUser);
    expect(verifySessionToken(devToken)).toBe(devUser);

    // Development mode with custom local secret
    setAuthSecret('local-custom-dev-key');
    expect(getAuthSecret()).toBe('local-custom-dev-key');
    const customDevToken = createSessionToken(devUser);
    expect(verifySessionToken(customDevToken)).toBe(devUser);

    // Test mode (NODE_ENV=test)
    setNodeEnv('test');
    setAuthSecret(undefined);
    expect(getAuthSecret()).toBe(DEFAULT_DEV_AUTH_SECRET);
    const testToken = createSessionToken(devUser);
    expect(verifySessionToken(testToken)).toBe(devUser);
  });

  it('8. Ensures environment variables are restored cleanly even when a test throws', () => {
    // Simulate a failure inside a lifecycle block
    const envBefore = process.env.NODE_ENV;
    const secretBefore = process.env.AUTH_SECRET;

    try {
      setNodeEnv('production');
      setAuthSecret('temporary-dirty-secret');
      throw new Error('Simulated failure during test execution');
    } catch {
      // simulate afterEach cleanup
      setNodeEnv(originalNodeEnv);
      setAuthSecret(originalAuthSecret);
    }

    expect(process.env.NODE_ENV).toBe(envBefore);
    expect(process.env.AUTH_SECRET).toBe(secretBefore);
  });

  it('9. Never leaks secret values or substrings into error messages', () => {
    setNodeEnv('production');
    const confidentialWeakSecret = 'adminadminadminadminadminadminadmin';
    setAuthSecret(confidentialWeakSecret);

    try {
      getAuthSecret();
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('SECURITY VIOLATION');
      expect(err.message).not.toContain(confidentialWeakSecret);
      expect(err.message).not.toContain('admin');
    }
  });

});
