import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseAdapter, sanitizeApiError } from '@/lib/db';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { checkRateLimit, getClientIp } from '@/lib/auth/rateLimit';

export async function POST(request: NextRequest) {
  try {
    const clientIp = getClientIp(request);
    const rateCheck = await checkRateLimit(`login:${clientIp}`, { max: 10, windowMs: 60 * 1000 });
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: 'Too many login attempts. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': Math.ceil((rateCheck.resetAt - Date.now()) / 1000).toString(),
          },
        }
      );
    }

    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required.' },
        { status: 400 }
      );
    }

    const db = getDatabaseAdapter();
    const user = await db.authenticateUser(email, password);

    if (!user) {
      return NextResponse.json(
        { error: 'Invalid email or password.' },
        { status: 401 }
      );
    }

    if (typeof db.isUserVerified !== 'function') {
      return NextResponse.json({ error: 'Email verification status cannot be established.' }, { status: 503 });
    }
    {
      const isVerified = await db.isUserVerified(user.id);
      if (!isVerified) {
        return NextResponse.json(
          { error: 'Please verify your email address before logging in. A confirmation email was sent to your inbox.' },
          { status: 403 }
        );
      }
    }

    const token = createSessionToken(user.id);
    const response = NextResponse.json({ user });

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
  } catch (err: any) {
    const { error, status } = sanitizeApiError(err, 'Login failed.');
    return NextResponse.json({ error }, { status });
  }
}
