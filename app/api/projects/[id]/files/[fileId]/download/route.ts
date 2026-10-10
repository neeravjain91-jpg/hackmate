import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth/session';
import { getDatabaseAdapter } from '@/lib/db';
import { getStorageAdapter } from '@/lib/storage';

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

    // 1. Enforce Project Membership Authorization
    const isMember = await db.isProjectMember(projectId, user.id);
    if (!isMember) {
      return NextResponse.json(
        { error: 'Forbidden. You do not have access to download files from this project.' },
        { status: 403 }
      );
    }

    // 2. Fetch File Metadata from Database
    const fileRecord = await db.getContributionFileById(fileId);
    if (!fileRecord) {
      return NextResponse.json({ error: 'File record not found.' }, { status: 404 });
    }

    // 3. Strict Cross-Project Prevention
    if (fileRecord.project_id !== projectId) {
      return NextResponse.json(
        { error: 'Forbidden. File does not belong to the requested project.' },
        { status: 403 }
      );
    }

    // 4. Retrieve bytes from Private Storage
    const storage = getStorageAdapter();
    const fileData = await storage.getFile(projectId, fileRecord.storage_path);

    if (!fileData || !fileData.buffer) {
      return NextResponse.json(
        { error: 'File data could not be retrieved from storage.' },
        { status: 404 }
      );
    }

    // 5. Stream byte-for-byte with exact headers
    const safeFilename = encodeURIComponent(fileRecord.file_name);
    const contentType = fileRecord.mime_type || 'application/octet-stream';

    return new Response(new Uint8Array(fileData.buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileData.buffer.length.toString(),
        'Content-Disposition': `attachment; filename="${fileRecord.file_name}"; filename*=UTF-8''${safeFilename}`,
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Download failed.' },
      { status: 500 }
    );
  }
}
