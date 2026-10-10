import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const projectId = params.id;
    const body = await request.json().catch(() => ({}));
    const { inviteCode } = body;

    const db = getDatabaseAdapter();
    const project = await db.getProjectById(projectId);
    if (!project) {
      return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    }

    if (inviteCode && project.invite_code.toUpperCase() !== inviteCode.trim().toUpperCase()) {
      return NextResponse.json({ error: 'Invalid invitation code.' }, { status: 400 });
    }

    const membership = await db.joinProject(projectId, user.id, 'member');

    return NextResponse.json({
      success: true,
      projectId,
      membership,
    });
  } catch (err: any) {
    const status = err.message?.includes('full') ? 409 : 400;
    return NextResponse.json({ error: err.message || 'Failed to join project.' }, { status });
  }
}
