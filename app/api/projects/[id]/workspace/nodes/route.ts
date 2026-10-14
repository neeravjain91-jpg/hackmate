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

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Malformed JSON payload.' }, { status: 400 });
    }

    const { name, parent_id, type, initialContent } = body || {};

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
    }

    const cleanName = name.trim();
    if (!cleanName || cleanName === '.' || cleanName === '..' || cleanName.includes('/') || cleanName.includes('\\') || cleanName.includes('\0')) {
      return NextResponse.json({ error: 'Invalid file or folder name. Name cannot be empty or contain path separators.' }, { status: 400 });
    }

    if (type !== 'file' && type !== 'folder') {
      return NextResponse.json({ error: 'Type must be "file" or "folder".' }, { status: 400 });
    }

    if (initialContent !== undefined && typeof initialContent !== 'string') {
      return NextResponse.json({ error: 'File content must be a string.' }, { status: 400 });
    }

    if (initialContent && Buffer.byteLength(initialContent, 'utf-8') > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'File content exceeds the maximum size limit of 10MB.' }, { status: 400 });
    }

    if (parent_id) {
      if (typeof parent_id !== 'string') {
        return NextResponse.json({ error: 'parent_id must be a string.' }, { status: 400 });
      }
      const parent = await db.getWorkspaceNode(parent_id);
      if (!parent || parent.project_id !== projectId || parent.type !== 'folder') {
        return NextResponse.json({ error: 'Parent folder not found in this project.' }, { status: 400 });
      }
    }

    const node = await db.createWorkspaceNode({
      project_id: projectId,
      parent_id: parent_id || null,
      name: cleanName,
      type,
      initialContent: initialContent || '',
      author_id: user.id,
      author_name: user.name,
    });

    return NextResponse.json({ node }, { status: 201 });
  } catch (err: any) {
    const isDuplicate = err.message?.includes('already exists');
    const status = isDuplicate ? 409 : 400;
    return NextResponse.json(
      { error: err.message || 'Failed to create workspace item.' },
      { status }
    );
  }
}
