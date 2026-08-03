import { UploadError } from "./errors";
import type { UploadPartFn } from "./uploader.types";

/** Default first-retry window; see `UploaderConfig.retryBaseMs`. */
export const RETRY_BASE_MS = 500;
/** Default backoff ceiling; see `UploaderConfig.retryCapMs`. */
export const RETRY_CAP_MS = 8_000;
/** A server's `Retry-After` is honored up to this; beyond it we would stall the whole queue. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** Default stall budget; see `UploaderConfig.stallTimeoutMs`. */
export const STALL_TIMEOUT_MS = 60_000;

let keyCounter = 0;

/**
 * A stable client-side identity for an upload. Used only for React keys — it is never transmitted,
 * persisted, or compared against anything server-side, so it needs uniqueness within the page and
 * nothing more.
 *
 * A plain counter rather than `crypto.randomUUID()`: that is unavailable outside a secure context
 * (plain HTTP on a LAN address is enough to make it `undefined`), and a random id would differ
 * between a server render and hydration, remounting every rehydrated row. A counter is deterministic,
 * so the same sequence of constructions yields the same keys on both sides.
 *
 * `useId` can't serve here — it is a hook returning one id per component, while uploads are
 * constructed from event handlers, and the models deliberately don't depend on React at all.
 */
export const nextUploadKey = (): string => `upload-${++keyCounter}`;

/**
 * The filename's extension, lowercased, or `""` when there isn't one.
 *
 * Deliberately reports what the name says and normalizes nothing — the reference implementation
 * rewrote `jpeg` to `jpg` for one backend's content-type table, which is an application concern.
 */
export const getFileExtension = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
};

/**
 * Whether another attempt against the same signed URL could plausibly succeed.
 *
 * - `0` — no response at all: network error, or our own stall abort
 * - `408` — server-side request timeout
 * - `429` — rate limited (`Retry-After` honored when present)
 * - `5xx` except `501` — transient server failure
 *
 * Everything else is fatal, most importantly `403`: an expired or mismatched presign fails
 * identically forever, so retrying it only delays the error.
 */
export const isRetryableStatus = (status: number): boolean =>
  status === 0 || status === 408 || status === 429 || (status >= 500 && status !== 501);

/** `Retry-After` as ms; accepts delta-seconds or an HTTP-date. */
export const parseRetryAfter = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

export interface RetryDelayOptions {
  baseMs?: number;
  capMs?: number;
  retryAfterMs?: number;
}

/**
 * Equal-jitter exponential backoff: half the window fixed, half random. Full jitter can return ~0ms,
 * which just re-hammers a server that is already struggling; a fixed delay synchronizes every part
 * of every file into a thundering herd.
 *
 * With the defaults (base 500, factor 2, cap 8000) a part's three retry delays are 250–500ms,
 * 500–1000ms and 1000–2000ms, so backoff totals at most 3.5s.
 *
 * @param attempt 1-based number of the attempt that just failed.
 */
export const retryDelayMs = (attempt: number, options?: RetryDelayOptions): number => {
  if (options?.retryAfterMs !== undefined) {
    return Math.min(options.retryAfterMs, MAX_RETRY_AFTER_MS);
  }
  const base = options?.baseMs ?? RETRY_BASE_MS;
  const window = Math.min(options?.capMs ?? RETRY_CAP_MS, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(window / 2 + Math.random() * (window / 2));
};

/**
 * The default part transport: a plain `PUT` of the part's blob to its signed URL.
 *
 * XHR rather than `fetch` because `fetch` still cannot report upload progress in most browsers.
 *
 * Every terminal path settles the promise — `onload`, `onerror`, `ontimeout`, `onabort`, and the
 * stall timer. The reference implementation registered only `onload` and `onerror`, so an aborted
 * part's promise never settled: the part stayed `UPLOADING` forever, permanently holding a
 * concurrency slot, and enough cancellations deadlocked the whole uploader.
 */
export const xhrPutUpload: UploadPartFn = (signal, part, onProgress) =>
  new Promise<void>((resolve, reject) => {
    const fileName = part.file.name;

    if (signal.aborted) {
      reject(new UploadError("ABORTED", { fileName }));
      return;
    }

    const stallMs = part.file.uploader.stallTimeoutMs;
    const xhr = new XMLHttpRequest();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;

    const onAbort = (): void => xhr.abort();

    const cleanup = (): void => {
      clearTimeout(stallTimer);
      signal.removeEventListener("abort", onAbort);
    };

    const armStall = (): void => {
      if (!stallMs) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, stallMs);
    };

    xhr.onload = (): void => {
      cleanup();
      // any 2xx, not just 200 — object stores answer 200/201/204 depending on the route, and the
      // reference treated 204 as a failure
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(
        new UploadError("PART", {
          fileName,
          status: xhr.status,
          retryAfterMs: parseRetryAfter(xhr.getResponseHeader("Retry-After")),
          message: `Part ${part.index + 1} of '${fileName}' failed: ${xhr.status} ${xhr.statusText}.`,
        }),
      );
    };

    xhr.onerror = (): void => {
      cleanup();
      reject(
        new UploadError("PART", {
          fileName,
          status: 0,
          message: `Network error uploading part ${part.index + 1} of '${fileName}'.`,
        }),
      );
    };

    xhr.ontimeout = (): void => {
      cleanup();
      reject(
        new UploadError("PART", {
          fileName,
          status: 0,
          message: `Timed out uploading part ${part.index + 1} of '${fileName}'.`,
        }),
      );
    };

    xhr.onabort = (): void => {
      cleanup();
      // a stall abort is our own doing and is retryable; a signal abort is cancellation
      reject(
        stalled
          ? new UploadError("PART", {
              fileName,
              status: 0,
              message: `Part ${part.index + 1} of '${fileName}' stalled for ${stallMs}ms.`,
            })
          : new UploadError("ABORTED", { fileName }),
      );
    };

    signal.addEventListener("abort", onAbort, { once: true });
    xhr.open("PUT", part.url);
    xhr.upload.onprogress = (event): void => {
      armStall();
      onProgress(event.loaded);
    };
    // Deliberately no headers. Content-Length is a forbidden header: the browser sets it from the
    // blob and a script cannot override it. That is exactly why part sizes must come from the
    // server rather than be derived client-side — see UploadPart.size.
    armStall();
    xhr.send(part.blob);
  });
