import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getDatabaseAdapter: vi.fn(),
  getSupabaseAuthClient: vi.fn(),
  createSupabaseAuthClient: vi.fn(),
  createSessionToken: vi.fn(() => 'session-test-token'),
}));

vi.mock('@/lib/db', () => ({ getDatabaseAdapter: mocks.getDatabaseAdapter }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseAuthClient: mocks.getSupabaseAuthClient,
  createSupabaseAuthClient: mocks.createSupabaseAuthClient,
}));
vi.mock('@/lib/auth/session', () => ({
  createSessionToken: mocks.createSessionToken,
  SESSION_COOKIE_NAME: 'hackmate_session',
}));
vi.mock('@/lib/auth/url', () => ({ getCanonicalAppUrl: () => 'https://hackmate.test' }));

import { GET as callbackHandler } from '@/app/api/auth/callback/route';

describe('email confirmation callback contract', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let verifyOtp: ReturnType<typeof vi.fn>;
  let db: any;

  beforeEach(() => {
    vi.clearAllMocks();
    verifyOtp = vi.fn();
    db = {
      isUserVerified: vi.fn().mockResolvedValue(true),
      getUserById: vi.fn().mockResolvedValue({ id: 'user-1', email: 'user@example.test' }),
      createUser: vi.fn(),
    };
    mocks.getDatabaseAdapter.mockReturnValue(db);
    const client = { auth: { verifyOtp } };
    mocks.getSupabaseAuthClient.mockReturnValue(client);
    mocks.createSupabaseAuthClient.mockReturnValue(client);
  });

  afterEach(() => {
    // NODE_ENV is controlled by Vitest and is intentionally not mutated here.
    void originalNodeEnv;
  });

  it('requires token_hash and explicit type=email, then calls verifyOtp with type=email', async () => {
    verifyOtp.mockResolvedValue({ data: { user: { id: 'user-1', email: 'user@example.test' } }, error: null });
    const missingType = await callbackHandler(new NextRequest('https://hackmate.test/api/auth/callback?token_hash=abc'));
    expect(new URL(missingType.headers.get('location')!).searchParams.get('error')).toBe('missing_verification_type');
    const valid = await callbackHandler(new NextRequest('https://hackmate.test/api/auth/callback?token_hash=abc&type=email'));
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc', type: 'email' });
    expect(valid.headers.get('set-cookie')).toContain('hackmate_session');
  });

  it('rejects missing token hash and PKCE code-only callbacks', async () => {
    const missing = await callbackHandler(new NextRequest('https://hackmate.test/api/auth/callback'));
    const pkce = await callbackHandler(new NextRequest('https://hackmate.test/api/auth/callback?code=pkce-code'));
    expect(new URL(missing.headers.get('location')!).searchParams.get('error')).toBe('missing_verification_params');
    expect(new URL(pkce.headers.get('location')!).searchParams.get('error')).toBe('unsupported_flow');
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('does not issue a session for invalid or expired tokens', async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { message: 'token expired' } });
    const response = await callbackHandler(new NextRequest('https://hackmate.test/api/auth/callback?token_hash=expired&type=email'));
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('verification_failed');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('fails closed when verification configuration is unavailable', async () => {
    mocks.getSupabaseAuthClient.mockReturnValue(null);
    mocks.createSupabaseAuthClient.mockReturnValue(null);
    const response = await callbackHandler(new NextRequest('https://hackmate.test/api/auth/callback?token_hash=abc&type=email'));
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('auth_unavailable');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not issue a session when verification status cannot be established', async () => {
    verifyOtp.mockResolvedValue({ data: { user: { id: 'user-1', email: 'user@example.test' } }, error: null });
    db.isUserVerified.mockResolvedValue(false);
    const response = await callbackHandler(new NextRequest('https://hackmate.test/api/auth/callback?token_hash=abc&type=email'));
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('verification_status_unavailable');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
