import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const body = await request.json();
    const { inviteCode } = body;

    if (!inviteCode || typeof inviteCode !== 'string' || !inviteCode.trim()) {
      return NextResponse.json({ error: 'Invite code is required.' }, { status: 400 });
    }

    const db = getDatabaseAdapter();
    const project = await db.getProjectByInviteCode(inviteCode.trim());

    if (!project) {
      return NextResponse.json({ error: 'Invalid invitation code. Project not found.' }, { status: 404 });
    }

    // Atomic join with strict 6-member limit check
    const membership = await db.joinProject(project.id, user.id, 'member');

    return NextResponse.json({
      success: true,
      projectId: project.id,
      membership,
    });
  } catch (err: any) {
    const status = err.message?.includes('full') ? 409 : 400;
    return NextResponse.json({ error: err.message || 'Failed to join project.' }, { status });
  }
}
