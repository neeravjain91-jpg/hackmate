import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';

export async function GET(
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

    const revisions = await db.getWorkspaceFileRevisions(fileId);
    if (revisions.length > 0) {
      if (revisions[0].project_id !== projectId) {
        return NextResponse.json({ error: 'File not found in this project.' }, { status: 404 });
      }
    } else {
      const file = await db.getWorkspaceFile(fileId);
      if (!file || file.project_id !== projectId) {
        return NextResponse.json({ error: 'File not found in this project.' }, { status: 404 });
      }
    }
    return NextResponse.json({ revisions });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
