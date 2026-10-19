import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }

    const projectId = params.id;
    const db = getDatabaseAdapter();

    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json(
        { error: 'Forbidden. You do not have access to this project workspace.' },
        { status: 403 }
      );
    }

    const tree = await db.getWorkspaceTree(projectId);
    return NextResponse.json({ tree });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to fetch workspace tree.' },
      { status: 500 }
    );
  }
}
