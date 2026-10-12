import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseAdapter } from '@/lib/db';
import { getSupabaseAuthClient, createSupabaseAuthClient } from '@/lib/supabase';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { getCanonicalAppUrl } from '@/lib/auth/url';

/**
 * Supabase Auth Email Verification Callback Route.
 *
 * Handles verification callbacks across separate serverless instances.
 * Supports:
 * 1. Stateless OTP token-hash flow (type=signup/email, token_hash=...)
 *    Compatible with standard Supabase email templates and fully functional
 *    across distinct serverless instances and devices without shared state.
 * 2. PKCE code exchange flow (code=...) with request-scoped client.
 *
 * Security Guarantees:
 * - Redirects stay strictly on the validated canonical origin.
 * - Fails closed: if profile creation or retrieval fails, NO session cookie is issued.
 * - Never leaks internal database errors in redirect query strings.
 * - Confirms existing profile ownership before authenticating.
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const tokenHash = requestUrl.searchParams.get('token_hash');
  const type = requestUrl.searchParams.get('type') || 'signup';
  const errorParam = requestUrl.searchParams.get('error');
  const errorDescription = requestUrl.searchParams.get('error_description');

  const canonicalOrigin = getCanonicalAppUrl();

  // If Supabase Auth redirected with an error (e.g. expired link)
  if (errorParam || errorDescription) {
    return NextResponse.redirect(
      new URL('/login?error=verification_failed&message=Email+verification+link+is+invalid+or+has+expired.', canonicalOrigin)
    );
  }

  // Obtain an auth client instance (fresh or configured)
  const authClient = getSupabaseAuthClient() || createSupabaseAuthClient();
  if (!authClient) {
    return NextResponse.redirect(
      new URL('/login?error=auth_unavailable&message=Authentication+service+is+temporarily+unavailable.', canonicalOrigin)
    );
  }

  let verifiedUser: { id: string; email?: string; user_metadata?: any } | null = null;

  try {
    if (tokenHash) {
      // 1. Stateless Token Hash / OTP Verification Flow (Supported across serverless instances)
      const { data, error } = await authClient.auth.verifyOtp({
        token_hash: tokenHash,
        type: type as any,
      });
      if (error || !data?.user) {
        return NextResponse.redirect(
          new URL('/login?error=verification_failed&message=Verification+token+is+invalid+or+has+expired.', canonicalOrigin)
        );
      }
      verifiedUser = data.user;
    } else if (code) {
      // 2. PKCE Code Exchange Flow
      const { data, error } = await authClient.auth.exchangeCodeForSession(code);
      if (error || !data?.user) {
        return NextResponse.redirect(
          new URL('/login?error=verification_failed&message=Verification+code+is+invalid+or+has+expired.', canonicalOrigin)
        );
      }
      verifiedUser = data.user;
    } else {
      return NextResponse.redirect(
        new URL('/login?error=missing_verification_params&message=Missing+verification+parameters.', canonicalOrigin)
      );
    }

    if (!verifiedUser?.id) {
      return NextResponse.redirect(
        new URL('/login?error=verification_failed&message=Unable+to+verify+user+identity.', canonicalOrigin)
      );
    }

    const db = getDatabaseAdapter();

    // 1. Check if profile already exists
    let profile = await db.getUserById(verifiedUser.id);

    if (profile) {
      // Verify ownership: profile email must match verified user email
      if (
        verifiedUser.email &&
        profile.email.toLowerCase() !== verifiedUser.email.toLowerCase()
      ) {
        return NextResponse.redirect(
          new URL('/login?error=profile_mismatch&message=User+profile+identity+mismatch.', canonicalOrigin)
        );
      }
    } else {
      // 2. Attempt persistent profile creation
      const name =
        (verifiedUser.user_metadata?.name as string) ||
        (verifiedUser.email ? verifiedUser.email.split('@')[0] : 'Student');
      const avatar_url = (verifiedUser.user_metadata?.avatar_url as string) || null;

      try {
        profile = await db.createUser({
          id: verifiedUser.id,
          email: verifiedUser.email || '',
          name,
          avatar_url,
        });
      } catch {
        // Fail closed: Profile creation failed in persistent database
        return NextResponse.redirect(
          new URL('/login?error=profile_creation_failed&message=Unable+to+initialize+user+profile.+Please+try+logging+in.', canonicalOrigin)
        );
      }
    }

    // 3. Confirm profile is persisted and retrievable
    const confirmedProfile = await db.getUserById(verifiedUser.id);
    if (!confirmedProfile) {
      return NextResponse.redirect(
        new URL('/login?error=profile_retrieval_failed&message=Unable+to+confirm+user+profile.+Please+try+logging+in.', canonicalOrigin)
      );
    }

    // 4. Issue session cookie ONLY after verified persistence
    const token = createSessionToken(verifiedUser.id);
    const response = NextResponse.redirect(
      new URL('/dashboard?verified=true', canonicalOrigin)
    );

    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });

    return response;
  } catch {
    // Fail closed with safe, generic message; never leak database or internal errors
    return NextResponse.redirect(
      new URL('/login?error=verification_failed&message=Email+verification+failed.+Please+try+again.', canonicalOrigin)
    );
  }
}
