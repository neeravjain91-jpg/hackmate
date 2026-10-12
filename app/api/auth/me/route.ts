import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { sanitizeApiError } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ user: null }, { status: 401 });
    }
    return NextResponse.json({ user });
  } catch (err: any) {
    const { error, status } = sanitizeApiError(err, 'Internal error');
    return NextResponse.json({ error }, { status });
  }
}
