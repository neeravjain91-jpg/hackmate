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
    const db = getDatabaseAdapter();

    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json(
        { error: 'Forbidden. You do not have access to this project workspace.' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { name, parent_id, type, initialContent } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
    }

    if (type !== 'file' && type !== 'folder') {
      return NextResponse.json({ error: 'Type must be "file" or "folder".' }, { status: 400 });
    }

    const node = await db.createWorkspaceNode({
      project_id: projectId,
      parent_id: parent_id || null,
      name: name.trim(),
      type,
      initialContent: initialContent || '',
      author_id: user.id,
      author_name: user.name,
    });

    return NextResponse.json({ node }, { status: 201 });
  } catch (err: any) {
    const status = err.message?.includes('already exists') ? 409 : 400;
    return NextResponse.json(
      { error: err.message || 'Failed to create workspace item.' },
      { status }
    );
  }
}
