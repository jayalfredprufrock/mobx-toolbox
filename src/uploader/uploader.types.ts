import type { CompletedUploadModel } from "./completed-upload.model";
import type { UploadError } from "./errors";
import type { FileModel } from "./file.model";
import type { PartModel } from "./part.model";
import type { UploaderModel } from "./uploader.model";

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * A part's lifecycle. Separate from `FileStatus`: parts have no signing or completion phase, and
 * they have a retry-backoff phase (`WAITING`) that files don't.
 *
 * `WAITING` exists so backoff costs no concurrency — only `UPLOADING` holds a part slot. It is a
 * real status rather than `QUEUED` plus a `retryAt` timestamp because the scheduler's eligibility
 * test has to be reactive, and MobX cannot invalidate a computed that reads the clock. The wait is
 * therefore expressed as a timer that flips the status, not as a comparison against `Date.now()`.
 *
 * There is no `CANCELED`: a canceled part is disposed and its file removed from the collection, so
 * no observer can ever see one.
 */
export type PartStatus = "QUEUED" | "UPLOADING" | "WAITING" | "COMPLETED" | "FAILED";

/**
 * A file's lifecycle. One member per phase with a distinct concurrency budget or a distinct set of
 * legal transitions:
 *
 * - `PENDING` — accepted, waiting for a slot. No network activity.
 * - `REQUESTING` — `requestUpload` is in flight. No parts exist yet.
 * - `UPLOADING` — parts exist. The only status whose parts are eligible for part slots.
 * - `COMPLETING` — every part uploaded and `completeUpload` is in flight. Without this phase a
 *   `completeUpload` failure would have to retract an already-emitted value.
 * - `COMPLETED` — terminal success, and the only status that contributes to `values`.
 * - `FAILED` — terminal failure; re-enterable via `retry()`.
 *
 * There is no `QUEUED`: "parts exist but none has started" is not a phase, it is `UPLOADING` at
 * `progress === 0`. There is no `CANCELED`: a canceled upload is removed from `uploads`, which is
 * the single source of truth for whether an upload exists.
 */
export type FileStatus =
  | "PENDING"
  | "REQUESTING"
  | "UPLOADING"
  | "COMPLETING"
  | "COMPLETED"
  | "FAILED";

// ---------------------------------------------------------------------------
// wire shapes
// ---------------------------------------------------------------------------

/** One signed part URL and the exact number of bytes the server signed it for. */
export interface UploadPart {
  url: string;
  /**
   * Exact byte length of this part. **Not advisory** — the uploader slices the file with a running
   * offset from these sizes and never derives them itself.
   *
   * Backends that sign each part URL with `Content-Length` in `signableHeaders` reject any other
   * split with `403 SignatureDoesNotMatch`, because `Content-Length` is a forbidden header: the
   * browser derives it from the blob and a script cannot override it. Sizes must sum exactly to
   * `file.size`; a mismatch fails the file with `UploadError("PART_SIZES")` and is logged as an
   * integration bug.
   */
  size: number;
}

/** What `requestUpload` resolves to. */
export interface UploadRequestResult {
  /**
   * Server-side identifier, handed back to `completeUpload` / `cancelUpload` and emitted as the
   * form value. Opaque to the uploader — an S3 key, a UUID, anything.
   */
  id: string;
  /**
   * Canonical filename, carried explicitly rather than parsed out of `id`. Wins over the local
   * `File.name` once known, so server-side normalization or de-duplication shows up in the UI.
   */
  name: string;
  /** One entry per part, in order. An empty array is legal for a zero-byte file. */
  parts: UploadPart[];
}

/**
 * A completed upload, as emitted to `onChange` and accepted by `value`.
 *
 * `name` is required rather than optional, and a bare id is deliberately **not** accepted. The name is
 * not derivable from the id — an id may be a storage key that happens to end in a filename, or an
 * opaque uuid that doesn't — so a library that guessed would render a uuid as a filename for half its
 * consumers. Persist the name alongside the id in whatever holds your form value, or fetch it when the
 * form loads.
 */
export interface UploadValue {
  id: string;
  name: string;
}

/** Everything in `uploads`: files this uploader is uploading, plus rehydrated completed uploads. */
export type Upload = FileModel | CompletedUploadModel;

/**
 * The surface every `Upload` shares, so list UIs need no `instanceof` branching. The reference
 * implementation's two upload classes had no common shape, which is how single-file replacement
 * ended up cancelling only the in-flight files and leaving a rehydrated upload behind.
 */
export interface UploadLike {
  /** Stable client-side identity, for React keys. Never the server id. */
  readonly key: string;
  readonly name: string;
  readonly extension: string;
  readonly status: FileStatus;
  /** 0–100. Never `NaN`. */
  readonly progress: number;
  /** The server's identifier, once known. */
  readonly uploadId: string | undefined;
  /** The `{ id, name }` pair emitted to `onChange`, or `undefined` until the upload completes. */
  readonly value: UploadValue | undefined;
  readonly error: UploadError | undefined;
  remove(): void;
  activate(): void;
  dispose(): void;
}

/**
 * Transport for a single part attempt. Must reject with `UploadError("ABORTED")` when `signal`
 * aborts, and report cumulative bytes sent through `onProgress`.
 */
export type UploadPartFn = (
  signal: AbortSignal,
  part: PartModel,
  onProgress: (loaded: number) => void,
) => Promise<void>;

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export interface UploaderConfig {
  /**
   * Ask the server for an upload id and one signed URL per part. The `signal` aborts when the file
   * is removed or the uploader is disposed — forward it to your fetch/client so a cancel during
   * signing doesn't leave a request in flight.
   *
   * Not auto-retried: it is your API call through your client, which likely has its own retry
   * policy. Throw `UploadError` to control the message the user sees; any other throw is wrapped as
   * `UploadError("REQUEST", { cause })` and keeps its own message. Recover with `file.retry()`.
   */
  requestUpload: (signal: AbortSignal, file: FileModel) => Promise<UploadRequestResult>;

  /**
   * Optional client-driven finalization (e.g. `POST /uploads/:id/complete`) for backends that don't
   * complete the multipart upload themselves. Called at most once per file, after every part has
   * uploaded; the file sits in `COMPLETING` until it resolves and only then reaches `COMPLETED`, so
   * a failure surfaces as `FAILED` instead of retracting an already-emitted value. A rejection
   * produces `UploadError("COMPLETE", { cause })`; `file.retry()` re-issues just this call.
   *
   * **Must be idempotent.** If the uploader is disposed mid-call, `activate()` re-issues it — an
   * aborted request gives no evidence about whether the server processed it, and re-issuing an
   * idempotent call is strictly better than silently dropping an upload.
   */
  completeUpload?: (signal: AbortSignal, file: FileModel) => Promise<void>;

  /**
   * Best-effort server-side cleanup when an upload that never completed is removed (e.g.
   * `DELETE /uploads/:id`). Only called for files that obtained an `uploadId` and have not reached
   * `COMPLETED` — there is nothing to abort otherwise.
   *
   * Deliberately gets no `AbortSignal`: it is issued during teardown and must outlive the model.
   * Rejections are reported through `onError` and never block removal.
   */
  cancelUpload?: (file: FileModel) => void | Promise<void>;

  /**
   * Fires when a `COMPLETED` upload is removed, for consumers that want to delete the durable
   * object. `cancelUpload` covers only abandonment of an upload still in flight.
   */
  onRemove?: (value: UploadValue, uploader: UploaderModel) => void;

  /**
   * Override the part transport. Defaults to `xhrPutUpload` (XHR, because `fetch` still cannot
   * report upload progress). Also the seam that makes the uploader testable without a DOM.
   */
  uploadPart?: UploadPartFn;

  /**
   * Reject a file before it is added. Return a message to reject it, or nothing to accept it.
   * Called once per file in order, *after* earlier files in the same batch have been added — so a
   * count rule can read `uploader.uploads.length` and see them.
   *
   * Rejections surface as `UploadError("REJECTED")` through `onError` and never create an upload,
   * so a refused file cannot appear as a failed row.
   */
  validate?: (file: File, uploader: UploaderModel) => string | undefined | void;

  /**
   * Passed straight through to the hidden `<input type="file">` rendered by `<Uploader.Root>`.
   * Not re-checked by the model: the file dialog is the filter. If you need a hard guarantee (or
   * you call `addFiles` yourself), enforce it in `validate`.
   */
  accept?: string;
  /**
   * Whether the uploader holds more than one upload. Default `false`.
   *
   * Sets the hidden input's `multiple` attribute, and — unlike `accept` — also governs the
   * collection: in single-file mode `addFiles` *replaces* what is there rather than accumulating, so
   * the previous upload is removed (and cancelled or reported through `onRemove`) first.
   */
  multiple?: boolean;
  /** Passed straight through to the hidden input's `capture` attribute. */
  capture?: boolean | "user" | "environment";

  /**
   * How many uploads the field holds at once. Default: unlimited when `multiple` is set, `1` when it
   * isn't. Picks past the cap are refused with `UploadError("REJECTED")` through `onError`, and
   * `uploader.full` / `uploader.remainingSlots` let your UI gate on the same number.
   *
   * This lives here rather than in `validate` because it is the one limit that depends on the
   * *collection* rather than on the file: only the uploader can see both the files it is uploading and
   * the already-uploaded ones rehydrated from `value`. A design system's own file cap counts only local
   * `File`s, so it will happily accept a second file when one already exists server-side — leave that
   * setting open and let this one do the work.
   *
   * Limits that depend only on the file — type, size — belong to whatever does the selecting, since it
   * can reject before the uploader ever sees them. Use `accept` / `validate`, or your design system's
   * equivalents.
   *
   * The cap governs *picking*, not rehydration: `value` is authoritative, so a controlled value longer
   * than `maxFiles` is applied in full rather than silently truncated.
   */
  maxFiles?: number;

  /**
   * How many part uploads may be in flight at once, across all files. Default `4`.
   *
   * This also throttles signing: a file is only requested when the already-signed work can't keep
   * the pipeline busy without it, which keeps the number of signed-but-uncompleted uploads at
   * roughly this number and stops presigned URLs expiring while queued behind large files. Parts in
   * retry backoff hold no slot.
   */
  concurrency?: number;

  /**
   * Hard cap on signed-but-uncompleted uploads, for backends that advertise one (and reject the
   * next request outright). Default: unlimited, since `concurrency` already bounds this to roughly
   * its own value — set it when the backend's limit must be *guaranteed* rather than approximated.
   */
  maxPendingUploads?: number;

  /** Total attempts per part, including the first. Default `4`. */
  maxPartAttempts?: number;
  /** First backoff window in ms, doubling per attempt with equal jitter. Default `500`. */
  retryBaseMs?: number;
  /**
   * Backoff ceiling in ms. Default `8000`. With the defaults the three retry delays sum to at most
   * 3.5s, and nothing is ever awaited after the decision to fail.
   */
  retryCapMs?: number;
  /**
   * Abort and retry a part attempt after this long with no upload-progress event. Default `60000`;
   * `0` disables. A *stall* budget rather than `xhr.timeout`'s total-request budget, which no
   * single value can set correctly for both a 1 MB and a 500 MB part.
   */
  stallTimeoutMs?: number;
  /**
   * Override which part failures are retried. Default: no response (`status === 0`), 408, 429, and
   * 5xx other than 501. Everything else is fatal — notably 403, an expired or mismatched presign,
   * which fails identically no matter how many times it is retried.
   */
  isRetryable?: (error: UploadError) => boolean;

  /**
   * The controlled value: uploads that already exist server-side. Reconciled by `id`; uploads still
   * in flight are never touched. Passing the key at all (even as `undefined`) makes the uploader
   * controlled, so `undefined` and `[]` both mean "no uploads".
   */
  value?: UploadValue[];

  /**
   * Fires when the set of completed uploads changes. Compared structurally, so a fresh array of
   * fresh objects with the same contents is not a change. Requires `activate()`.
   */
  onChange?: (values: UploadValue[], uploader: UploaderModel) => void;

  /**
   * Every failure, including files refused by `validate` — which have no model to carry an `error`,
   * so this is the only way they become visible. Also receives failures already reflected on
   * `file.error`, for toasts and telemetry.
   */
  onError?: (error: UploadError, file: FileModel | undefined, uploader: UploaderModel) => void;
}

/** Constructor data for a `FileModel`. */
export interface FileConfig {
  file: File;
}

/** Constructor data for a `PartModel`. */
export interface PartConfig {
  index: number;
  url: string;
  blob: Blob;
}

/** Constructor data for a `CompletedUploadModel`. */
export interface CompletedUploadConfig {
  id: string;
  name: string;
}
