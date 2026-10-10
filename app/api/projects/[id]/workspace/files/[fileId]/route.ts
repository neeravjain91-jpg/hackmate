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

    const file = await db.getWorkspaceFile(fileId);
    if (!file || file.project_id !== projectId) {
      return NextResponse.json({ error: 'File not found.' }, { status: 404 });
    }

    return NextResponse.json({ file });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}

export async function PUT(
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

    const existingFile = await db.getWorkspaceFile(fileId);
    if (!existingFile || existingFile.project_id !== projectId) {
      return NextResponse.json({ error: 'File not found in this project.' }, { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Malformed JSON payload.' }, { status: 400 });
    }

    const { content, baseRevision } = body || {};

    if (content === undefined || typeof content !== 'string') {
      return NextResponse.json({ error: 'File content must be a string.' }, { status: 400 });
    }

    if (Buffer.byteLength(content, 'utf-8') > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'File content exceeds the maximum size limit of 10MB.' }, { status: 400 });
    }

    if (
      baseRevision !== undefined &&
      (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 1)
    ) {
      return NextResponse.json({ error: 'Valid positive integer baseRevision is required.' }, { status: 400 });
    }

    const result = await db.saveWorkspaceFile(
      fileId,
      content,
      baseRevision,
      user.id,
      user.name
    );

    if (result.conflict) {
      return NextResponse.json(
        {
          error: `Conflict detected: This file has been updated to revision ${result.currentRevision} by another teammate.`,
          conflict: true,
          currentRevision: result.currentRevision,
          file: result.file,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ file: result.file, conflict: false });
  } catch (err: any) {
    const isConflict = err.message?.includes('Conflict');
    const status = isConflict ? 409 : 500;
    return NextResponse.json({ error: err.message || 'Failed to save file.' }, { status });
  }
}
