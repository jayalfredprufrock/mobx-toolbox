export type UploadErrorType =
  | "REJECTED"
  | "REQUEST"
  | "PART"
  | "PART_SIZES"
  | "COMPLETE"
  | "ABORTED";

export interface UploadErrorOptions {
  message?: string;
  cause?: unknown;
  /** Name of the file the failure concerns. Feeds the default message. */
  fileName?: string;
  /** HTTP status for `PART` failures. `0` means no response at all: network error or stall. */
  status?: number;
  /** Parsed `Retry-After`, in ms. Honored by the retry policy when present. */
  retryAfterMs?: number;
}

const defaultMessage = (type: UploadErrorType, fileName?: string): string => {
  const file = fileName ? `'${fileName}'` : "the file";
  switch (type) {
    case "REJECTED":
      return `${file} was rejected before it was added.`;
    case "REQUEST":
      return `Could not start the upload for ${file}.`;
    case "PART":
      return `A part of ${file} failed to upload.`;
    case "PART_SIZES":
      return `The requested part sizes for ${file} do not add up to the file's size.`;
    case "COMPLETE":
      return `The upload of ${file} could not be finalized.`;
    case "ABORTED":
      return `The upload of ${file} was aborted.`;
  }
};

/**
 * The single error type the uploader surfaces. `type` discriminates the failure source; when the
 * uploader wraps an application-level error (a rejected `requestUpload`, a transport failure), the
 * original is preserved on the standard `cause` property.
 *
 * Consumers may also throw `UploadError` from `requestUpload` / `completeUpload` — e.g.
 * `throw new UploadError("REQUEST", { message: "Daily quota reached." })` — and it passes through
 * unwrapped, so the message reaches `file.error` verbatim.
 */
export class UploadError extends Error {
  readonly type: UploadErrorType;
  readonly fileName?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  /**
   * Whether this is a bug in the integration rather than a runtime condition. Dev-bug errors are
   * logged unconditionally in addition to being surfaced, and are never retried — retrying a
   * contract violation only hides it.
   */
  get dev(): boolean {
    return this.type === "PART_SIZES";
  }

  constructor(type: UploadErrorType, options?: UploadErrorOptions) {
    super(options?.message ?? defaultMessage(type, options?.fileName), { cause: options?.cause });
    this.name = "UploadError";
    this.type = type;
    this.fileName = options?.fileName;
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * Wrap anything thrown by a consumer callback. An existing `UploadError` passes through unchanged
 * so a deliberate `throw new UploadError(...)` keeps its type and message. Otherwise a thrown
 * `Error`'s own message is preferred over the generic default — consumers throw from
 * `requestUpload` precisely to say something specific ("Files cannot be larger than 10 MB"), and
 * replacing that with "Could not start the upload" would throw away the only useful part.
 */
export const toUploadError = (
  error: unknown,
  type: UploadErrorType,
  options?: UploadErrorOptions,
): UploadError => {
  if (error instanceof UploadError) return error;
  const message =
    options?.message ?? (error instanceof Error && error.message ? error.message : undefined);
  return new UploadError(type, { ...options, message, cause: error });
};
