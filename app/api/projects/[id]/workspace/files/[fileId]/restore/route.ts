import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; fileId: string } }
) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const { id: projectId, fileId } = params;
    const db = getDatabaseAdapter();

    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
    }

    const file = await db.getWorkspaceFile(fileId);
    if (!file || file.project_id !== projectId) {
      return NextResponse.json({ error: 'File not found in this project.' }, { status: 404 });
    }

    const body = await request.json();
    const { revisionNumber } = body;

    if (!revisionNumber || typeof revisionNumber !== 'number') {
      return NextResponse.json({ error: 'Valid revisionNumber is required.' }, { status: 400 });
    }

    const restoredFile = await db.restoreWorkspaceRevision(
      fileId,
      revisionNumber,
      user.id,
      user.name
    );

    return NextResponse.json({ file: restoredFile });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to restore revision.' }, { status: 400 });
  }
}
