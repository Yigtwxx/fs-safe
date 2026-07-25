export type ArchiveFormatErrorCode = "archive-header-invalid";

export class ArchiveFormatError extends Error {
  readonly code: ArchiveFormatErrorCode;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArchiveFormatError";
    this.code = "archive-header-invalid";
  }
}
