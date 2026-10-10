export interface StoredFileResult {
  storagePath: string;
  checksum: string;
  fileSize: number;
}

export interface IStorageAdapter {
  saveFile(
    projectId: string,
    fileId: string,
    fileName: string,
    buffer: Buffer,
    mimeType: string
  ): Promise<StoredFileResult>;

  getFile(
    projectId: string,
    storagePath: string
  ): Promise<{ buffer: Buffer; mimeType?: string } | null>;

  deleteFile(projectId: string, storagePath: string): Promise<boolean>;
}
