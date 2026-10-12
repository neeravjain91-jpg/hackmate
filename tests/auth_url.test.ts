import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCanonicalAppUrl } from '@/lib/auth/url';

describe('canonical application URL configuration', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVercel = process.env.VERCEL;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  function setEnv(key: string, value: string | undefined): void {
    const env = process.env as Record<string, string | undefined>;
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  beforeEach(() => {
    setEnv('NODE_ENV', 'test');
    setEnv('VERCEL', undefined);
    setEnv('NEXT_PUBLIC_APP_URL', undefined);
  });

  afterEach(() => {
    setEnv('NODE_ENV', originalNodeEnv);
    setEnv('VERCEL', originalVercel);
    setEnv('NEXT_PUBLIC_APP_URL', originalAppUrl);
  });

  it('uses localhost as the development default when no URL is configured', () => {
    expect(getCanonicalAppUrl()).toBe('http://localhost:3000');
  });

  it('returns the origin of a valid development URL', () => {
    setEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000/nested/path');
    expect(getCanonicalAppUrl()).toBe('http://localhost:3000');
  });

  it('requires an explicit canonical URL in production', () => {
    setEnv('NODE_ENV', 'production');
    expect(() => getCanonicalAppUrl()).toThrow(/NEXT_PUBLIC_APP_URL must be configured.*HTTPS origin/i);
  });

  it('also requires an explicit canonical URL on Vercel even if NODE_ENV is not production', () => {
    setEnv('VERCEL', '1');
    expect(() => getCanonicalAppUrl()).toThrow(/NEXT_PUBLIC_APP_URL must be configured.*HTTPS origin/i);
  });

  it('rejects malformed production URLs without falling back to another deployment', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('NEXT_PUBLIC_APP_URL', 'not-a-valid-origin');
    expect(() => getCanonicalAppUrl()).toThrow(/NEXT_PUBLIC_APP_URL must be configured.*HTTPS origin/i);
  });

  it('rejects HTTP URLs in production', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('NEXT_PUBLIC_APP_URL', 'http://hackmate.example');
    expect(() => getCanonicalAppUrl()).toThrow(/NEXT_PUBLIC_APP_URL must be configured.*HTTPS origin/i);
  });

  it('accepts a configured production HTTPS URL and normalizes it to origin', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('NEXT_PUBLIC_APP_URL', 'https://hackmate.example/path?ignored=yes');
    expect(getCanonicalAppUrl()).toBe('https://hackmate.example');
  });
});
