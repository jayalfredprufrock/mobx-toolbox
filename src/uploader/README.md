# @mobx-toolbox/uploader

A headless multipart upload engine for MobX + React. The model owns everything about _uploading_ — part slicing, concurrency, progress, retries, cancellation, and the completed-upload form value. You own everything about _selecting_: the file input, the drop zone, the list markup, and every pixel.

- **Bring your own selection UI.** Two thin components are included for consumers with no design system, but the engine is driven by one call — `uploader.addFiles(files)` — so it drops straight into Chakra's `FileUpload`, Ark UI, or a bare `<input>`.
- **Server-supplied part sizes.** The client never derives a part boundary, because a backend that signs each part URL with an exact `Content-Length` rejects any other split.
- **Bounded by one number.** `concurrency` caps parts in flight _and_ throttles how far ahead files are signed, so presigned URLs don't expire in a queue and a backend's pending-upload limit isn't tripped.

## Setup

```tsx
import { useUploader, Uploader } from "@jayalfredprufrock/mobx-toolbox/uploader";

function DocumentUpload({ value, onChange }) {
  const uploader = useUploader({
    accept: ".pdf",
    value,
    onChange,

    requestUpload: async (signal, file) => {
      const res = await api.requestUpload({ fileName: file.name, size: file.size }, { signal });
      return { id: res.id, name: res.fileName, parts: res.parts };
    },

    // only if your backend expects the client to finalize
    completeUpload: (signal, file) => api.completeUpload(file.uploadId!, { signal }),

    // best-effort cleanup when an unfinished upload is removed
    cancelUpload: (file) => api.cancelUpload(file.uploadId!),
  });

  return (
    <Uploader.Root uploader={uploader}>
      <MyDropSurface />
      <ul>
        <Uploader.Uploads>
          {(upload) => (
            <li>
              {upload.name} — {upload.status} {upload.progress}%
              <button type="button" onClick={() => upload.remove()}>
                remove
              </button>
            </li>
          )}
        </Uploader.Uploads>
      </ul>
    </Uploader.Root>
  );
}
```

`Uploader.Root` renders **no wrapper element** — only the hidden `<input type="file">` and a provider. Wrap the children in your own container. To open the file dialog, take `openFileDialog` off the context and hang it on your own button:

```tsx
const { openFileDialog } = useUploaderContext();

<MyButton onClick={openFileDialog}>browse</MyButton>;
```

That is deliberately the whole selection surface. Drag-and-drop is **not** included: it needs an enter/leave depth counter, a `preventDefault` on every `dragover`, a document-level drop guard, and `dataTransfer.types` rather than `items` — and every design system worth using already ships it.

## Uploads

`uploader.uploads` holds two kinds of entry behind one shape (`UploadLike`), so list UIs never need an `instanceof` branch:

- **`FileModel`** — a local `File` being uploaded. Has `file`, `size`, `type`, `isImage`, `objectUrl`, `parts`, `retry()`.
- **`CompletedUploadModel`** — an upload that already exists server-side, rehydrated from `value`. No blob, no parts.

Both expose `key`, `name`, `extension`, `status`, `progress`, `uploadId`, `value`, `error` and `remove()`.

`key` is a stable client-side id for React keys. `uploadId` is the **server's** identifier and is `undefined` until `requestUpload` resolves — don't key on it.

### Status

```
PENDING → REQUESTING → UPLOADING → COMPLETING → COMPLETED
                            ↓           ↓
                          FAILED ←──────┘
```

`COMPLETING` only occurs when `completeUpload` is configured. A file reaches `COMPLETED` — and therefore enters the form value — only _after_ that call resolves, so a finalization failure surfaces as `FAILED` instead of retracting a value the consumer already stored.

There is no `CANCELED`. Removing an upload takes it out of `uploads`, which is the single source of truth for whether it exists.

### Previews

`file.objectUrl` mints a blob URL on first read and `dispose()` revokes it. It returns `undefined` — not `""` — for files that aren't images or video, so you can branch honestly rather than rendering `<img src="">`.

## The controlled value

The value is `{ id, name }[]`. The name is **carried, never inferred**: deriving it from the identifier only works when the identifier happens to be a storage key, and renders a raw UUID otherwise.

```tsx
const uploader = useUploader({
  value: doc.uploadId ? [{ id: doc.uploadId, name: doc.fileName }] : undefined,
  onChange: (values) => {
    doc.uploadId = values[0]?.id;
    doc.fileName = values[0]?.name;
  },
  requestUpload,
});
```

Passing the `value` **key** makes the uploader controlled — `undefined` and `[]` both mean "no uploads". Omit the key entirely and the uploader owns its own list while `onChange` still fires as a notification.

Reconciliation rules:

|                           |                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Array and object identity | irrelevant in both directions — emit fresh arrays freely                                              |
| Inbound matching          | by `id`; duplicate ids collapse                                                                       |
| Inbound removal           | only `COMPLETED` uploads. An upload still working was never in your value, so an echo can't cancel it |
| Inbound `name`            | authoritative for rehydrated uploads; ignored for uploads created from a picked `File`                |
| Outbound                  | `comparer.structural` over the whole array, so an equal array is not a change                         |

`onChange` requires `activate()`, which `useUploader` handles. Initial `value` is applied before the reaction is armed, so mounting with a rehydrated value doesn't immediately dirty your form.

## Validation

One hook, so the messages and the rules are yours:

```ts
useUploader({
  accept: ".pdf",
  validate: (file, uploader) => {
    if (uploader.uploads.length >= maxFiles) return `You may only upload ${maxFiles} file(s).`;
    if (file.size > maxSize) return `Files cannot be larger than ${formatBytes(maxSize)}.`;
  },
  onError: (error, file) => toast(error.message),
  requestUpload,
});
```

`validate` runs once per file, in order, _after_ earlier files in the same batch have been added — so a count rule sees them. A rejected file **never enters `uploads`**, so it can't appear as a failed row; `onError` receives `UploadError("REJECTED")` with no `file` argument, because there is no model to hang it on.

`accept`, `multiple` and `capture` are passed to the hidden input's attributes. Only `multiple` also affects the model: in single-file mode `addFiles` **replaces** what's there rather than accumulating. Enforce anything you need as a hard guarantee in `validate` — the input's `accept` is a dialog filter, not a contract.

## Part sizes

`requestUpload` must return the **exact** byte length of every part:

```ts
{ id: "…", name: "report.pdf", parts: [{ url, size: 67108864 }, { url, size: 37748736 }] }
```

The uploader slices with a running offset from those sizes and never derives them. This is not a style preference: backends that sign each part URL with `Content-Length` in `signableHeaders` reject any other split with `403 SignatureDoesNotMatch`, because `Content-Length` is a forbidden header — the browser sets it from the blob and a script cannot override it. An even client-side split therefore breaks silently for every file past the first part boundary.

Sizes must sum exactly to `file.size`. A mismatch fails the file with `UploadError("PART_SIZES")`, logs it as an integration bug, and builds no parts. If your backend doesn't send sizes, compute them in your adapter — don't guess in the model.

An empty `parts` array is legal for a zero-byte file, which completes without touching the network.

## Concurrency

```ts
useUploader({ concurrency: 4, maxPendingUploads: 10, requestUpload });
```

`concurrency` (default 4) bounds parts in flight across all files. It also throttles signing: a file is requested only when the already-signed work can't keep the pipeline busy without it. So:

| Workload               | Parts in flight | Signed-but-unfinished uploads |
| ---------------------- | --------------- | ----------------------------- |
| Many single-part files | `concurrency`   | ~`concurrency + 1`            |
| Few multi-part files   | `concurrency`   | 1–2                           |

That keeps presigned URLs from expiring while queued behind a large file, and keeps a backend's pending-upload limit satisfied without a second knob. `maxPendingUploads` (default unlimited) turns that approximation into a guarantee when the backend rejects the next request outright.

Parts drain **file-by-file** rather than interleaving. An upload is worthless until all its parts land, so FIFO over indivisible jobs means the first file is usable early instead of every file finishing late.

Progress is **byte-weighted** at both levels, so a 1 GB file doesn't count the same as a 1 KB one, and is always a number — never `NaN`.

## Retries and failures

Parts retry automatically: 4 attempts, exponential backoff from 500 ms with equal jitter, capped at 8 s, honoring `Retry-After`. A part in backoff holds **no** concurrency slot, and `FAILED` is written the instant the last attempt fails.

Retryable: no response (`status === 0`), 408, 429, and 5xx except 501. Everything else is fatal — notably **403**, an expired presign, which would fail identically forever. Override with `isRetryable`.

`stallTimeoutMs` (default 60 s, `0` disables) aborts and retries a part after that long with no progress event. It's a _stall_ budget rather than `xhr.timeout`, which is a total-request budget no single value can set correctly for both a 1 MB and a 500 MB part.

`requestUpload` and `completeUpload` are **not** auto-retried — they're your API calls through your client, which probably has its own policy. Recover with `file.retry()`, which re-signs, re-queues only the failed parts, or re-issues only the completion call, depending on what failed.

All failures are `UploadError` with a discriminating `type` (`REJECTED`, `REQUEST`, `PART`, `PART_SIZES`, `COMPLETE`, `ABORTED`), the original on `cause`, and `status`/`retryAfterMs` where relevant. A thrown `Error`'s own message is preserved, so `throw new Error("Daily quota reached.")` from `requestUpload` reaches the user verbatim.

## Using it with Chakra UI or Ark UI

`@zag-js/file-upload` — under Chakra v3's `FileUpload` and Ark's — already owns the input, drop zone, trigger, `accept`/`maxFiles`/`maxFileSize`/`validate`, rejection reporting, the item list, and `createFileUrl`. Let it. Skip `Uploader.Root`/`Uploader.Uploads` entirely and wire the engine to `onFileAccept`:

```tsx
const uploader = useUploader({ requestUpload, completeUpload, value, onChange });

<FileUpload.Root
  accept={["application/pdf"]}
  maxFiles={5}
  maxFileSize={10_000_000}
  acceptedFiles={uploader.files.map((file) => file.file)}
  onFileAccept={({ files }) => uploader.addFiles(files)}
  onFileReject={({ files }) => toast(files)}
>
  <FileUpload.HiddenInput />
  <FileUpload.Dropzone>Drop a file, or click to browse</FileUpload.Dropzone>
  <FileUpload.ItemGroup>
    {uploader.uploads.map((upload) => (
      <MyUploadRow key={upload.key} upload={upload} />
    ))}
  </FileUpload.ItemGroup>
</FileUpload.Root>;
```

Two notes. Controlling `acceptedFiles` from `uploader.files` keeps Zag's `maxFiles` accounting and its `Item` parts in sync with removals made through the model — `FileModel.file` is public for exactly this. And rehydrated `CompletedUploadModel`s have no `File`, so they can't go through Zag's `Item` parts; render those rows yourself.

Because the two layers overlap, don't configure the same rule twice: if Zag is doing `accept` and `maxFileSize`, leave `accept` and `validate` off the uploader.

## Testing

`uploadPart` replaces the XHR transport, so the scheduler, retry policy and cancellation are all testable with no XHR, no DOM, and no fake timers for anything but backoff:

```ts
const uploader = new UploaderModel({
  requestUpload,
  uploadPart: (signal, part, onProgress) => new Promise((resolve, reject) => { … }),
});
uploader.activate();
```

`pump()` is synchronous and idempotent, so scheduling is assertable on the next line with no reaction flush.

## API notes

### `UploaderModel`

| Member                                           |                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `uploads`                                        | every upload, in display order                                  |
| `files`                                          | just the `FileModel`s                                           |
| `values` / `ids`                                 | the completed set as `{ id, name }[]` / `string[]`              |
| `progress`                                       | 0–100, byte-weighted across non-failed files                    |
| `uploading` / `failed` / `invalid`               | anything working / anything failed / anything not yet completed |
| `errors`                                         | every error currently attached to an upload                     |
| `activeParts` / `queuedParts` / `pendingUploads` | scheduler state                                                 |

Actions: `addFiles`, `addCompletedUpload`, `applyValue`, `removeUpload`, `clear`, `retryAll`, `pump`, `activate`, `dispose`.

### Lifecycle

`useUploader` pairs `activate()`/`dispose()` in an effect. `dispose()` **parks** rather than destroys: it aborts in-flight work, clears timers, revokes preview URLs and drops the `onChange` reaction, but leaves `uploads` in place with resumable statuses. `activate()` picks them back up. That is what makes a StrictMode dev remount — and an uploader owned by a long-lived store — behave sanely instead of restarting every upload.

One consequence: `completeUpload` **must be idempotent**, because parking mid-call means `activate()` re-issues it. An aborted request gives no evidence about whether the server processed it, and re-issuing an idempotent call beats silently dropping an upload.
