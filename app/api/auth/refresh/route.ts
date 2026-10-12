import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest, createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { sanitizeApiError } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Session expired or invalid.' }, { status: 401 });
    }

    const token = createSessionToken(user.id);
    const response = NextResponse.json({ user, token });

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
    const { error, status } = sanitizeApiError(err, 'Session refresh failed.');
    return NextResponse.json({ error }, { status });
  }
}
