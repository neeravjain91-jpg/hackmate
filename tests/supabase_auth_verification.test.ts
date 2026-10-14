import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseDatabaseAdapter } from '@/lib/db/supabaseDb';

describe('SupabaseDatabaseAdapter.isUserVerified fail-closed behavior', () => {
  const originalOverride = process.env.AUTH_AUTO_CONFIRM_EMAILS;

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.AUTH_AUTO_CONFIRM_EMAILS;
    else process.env.AUTH_AUTO_CONFIRM_EMAILS = originalOverride;
  });

  beforeEach(() => {
    delete process.env.AUTH_AUTO_CONFIRM_EMAILS;
  });

  function adapterWith(admin: any): SupabaseDatabaseAdapter {
    return new SupabaseDatabaseAdapter({ auth: { admin } } as any, {} as any);
  }

  it('returns false when admin.getUserById support is missing', async () => {
    const adapter = adapterWith({});
    await expect(adapter.isUserVerified('user-1')).resolves.toBe(false);
  });

  it('returns false when the administrative lookup fails', async () => {
    const getUserById = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { message: 'lookup unavailable' },
    });
    await expect(adapterWith({ getUserById }).isUserVerified('user-1')).resolves.toBe(false);
    expect(getUserById).toHaveBeenCalledWith('user-1');
  });

  it('returns false when the Auth record is unconfirmed', async () => {
    const getUserById = vi.fn().mockResolvedValue({
      data: { user: { id: 'user-1', email_confirmed_at: null, confirmed_at: null } },
      error: null,
    });
    await expect(adapterWith({ getUserById }).isUserVerified('user-1')).resolves.toBe(false);
  });

  it('returns true only when the Auth record has a confirmation timestamp', async () => {
    const getUserById = vi.fn().mockResolvedValue({
      data: { user: { id: 'user-1', email_confirmed_at: '2026-10-12T00:00:00.000Z' } },
      error: null,
    });
    await expect(adapterWith({ getUserById }).isUserVerified('user-1')).resolves.toBe(true);
  });

  it('allows only the explicitly enabled administrative auto-confirm override to bypass lookup', async () => {
    process.env.AUTH_AUTO_CONFIRM_EMAILS = 'true';
    const getUserById = vi.fn();
    await expect(adapterWith({ getUserById }).isUserVerified('user-1')).resolves.toBe(true);
    expect(getUserById).not.toHaveBeenCalled();
  });
});
