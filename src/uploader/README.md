# @mobx-toolbox/uploader

A headless multipart upload engine for MobX + React. The model owns everything about _uploading_ — part slicing, concurrency, progress, retries, cancellation, and the completed-upload form value. You own everything about _selecting_: the file input, the drop zone, the list markup, and every pixel.

- **Bring your own selection UI.** Two thin components are included for consumers with no design system, but the engine is driven by one call — `addFiles` for a delta, `setFiles` to reconcile a whole list — so it drops straight into Chakra's `FileUpload`, Ark UI, or a bare `<input>`.
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

### Editing a record that already has a file

This is the case most file-picker components have no answer for. Chakra's `FileUpload`, Ark's, and react-dropzone all model a `File[]` selection, and a file uploaded last week is not a `File` — so the usual workaround is to render the existing file in your own markup _outside_ the picker and manage the field by hand.

This library models it instead, because it owns the form value: `value` is the set of completed uploads, and that set includes ones from previous sessions. Rehydrated entries become `CompletedUploadModel`s and sit in `uploads` alongside in-flight ones behind the same `UploadLike` shape, so you render one list and call one `remove()`.

**You must supply the name.** `value` takes `{ id, name }` and a bare id is not accepted, because the name is not derivable from the id — an id may be a storage key ending in a filename, or an opaque uuid. Two honest options:

- **Persist the filename next to the id** in whatever holds the field. One extra column, and it's the option with no round-trip.
- **Fetch it when the form loads** — you likely already have a `getUpload`-style endpoint — and pass `value` once it arrives. `applyValue` is idempotent, so a late-arriving value just reconciles.

If your id genuinely is a storage key, deriving the name is a one-liner _in your code_, where the knowledge that ids look like that belongs:

```tsx
value={key ? [{ id: key, name: key.replace(/^.*[\\/]/, "") }] : undefined}
```

Removing a rehydrated upload fires `onRemove(value)`, not `cancelUpload` — there is nothing in flight to abort. That is the hook for deleting the durable object, if that's your semantics; if the field should merely stop referencing it, ignore `onRemove` and let `onChange` do the work.

## Limits and validation

`maxFiles` is config; everything else is a hook.

```ts
useUploader({
  accept: ".pdf",
  maxFiles: 5,
  validate: (file) => {
    if (file.size > maxSize) return `Files cannot be larger than ${formatBytes(maxSize)}.`;
  },
  onError: (error, file) => toast(error.message),
  requestUpload,
});
```

The split isn't arbitrary: **the library owns limits that depend on the collection, and whatever does the selecting owns limits that depend on a single file.**

`maxFiles` needs the collection, and only the uploader has it — it is the one thing that sees both the files it is uploading and the already-uploaded ones rehydrated from `value`. Every other picker counts local `File`s only, so it will accept a second file when one already exists server-side. `maxFiles` defaults to unlimited with `multiple`, `1` without, and `uploader.full` / `uploader.remainingSlots` expose the same number so your browse control can gate on it instead of keeping a second count:

```tsx
{
  !uploader.full && <MyBrowseButton />;
}
```

Type and size need only the file, so they can be rejected before the uploader ever sees it — leave them to `accept`, `validate`, or your design system's equivalents.

Picks past the cap are refused with `UploadError("REJECTED")` through `onError`. The cap governs picking, not rehydration: a controlled `value` is authoritative, so one longer than `maxFiles` is applied in full rather than silently dropping persisted uploads.

`validate` runs once per file, in order, _after_ earlier files in the same batch have been added — so a count rule sees them. A rejected file **never enters `uploads`**, so it can't appear as a failed row; `onError` receives `UploadError("REJECTED")` with no `file` argument, because there is no model to hang it on.

`accept`, `multiple` and `capture` are passed to the hidden input's attributes. Only `multiple` also affects the model: in single-file mode `addFiles` **replaces** what's there rather than accumulating, and both `addFiles` and `setFiles` keep only the last file of a batch. Enforce anything you need as a hard guarantee in `validate` — the input's `accept` is a dialog filter, not a contract.

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
const uploader = useUploader({ maxFiles: 5, requestUpload, completeUpload, value, onChange });

<FileUpload.Root
  accept={["application/pdf"]}
  maxFileSize={10_000_000}
  // NOT Zag's maxFiles — it counts only local Files, so it can't see rehydrated uploads.
  // Pass maxFiles to useUploader instead; it counts both kinds.
  maxFiles={Number.POSITIVE_INFINITY}
  acceptedFiles={uploader.files.map((file) => file.file)}
  // setFiles, NOT addFiles — see below
  onFileAccept={({ files }) => uploader.setFiles(files)}
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

**Use `setFiles`, not `addFiles`.** `onFileAccept` fires from the machine's `acceptedFiles` binding, so it receives the **entire** accepted list, not the newly-picked delta — and it fires on deletions too. `addFiles` would re-add everything already present, so a second pick would duplicate the first file. `setFiles` reconciles: matched files keep their upload (and its in-flight progress), absent ones are removed and cancelled, new ones are added. Matching is by reference then by name + size + type, the same identity Zag's `isFileEqual` uses.

Because `setFiles` handles removals, `FileUpload.ItemDeleteTrigger` works as-is — deleting shortens `acceptedFiles`, which fires `onFileAccept`, which drops the upload. Calling `upload.remove()` yourself works too, and controlling `acceptedFiles` from `uploader.files` is what keeps the two directions consistent (`FileModel.file` is public for exactly this).

**Don't set Zag's `maxFiles` — set the uploader's.** `acceptedFiles` holds only local `File`s, so a rehydrated upload is invisible to it: with Zag's `maxFiles={1}` and one already-uploaded file it counts zero and accepts a second pick. Leave it open and pass `maxFiles` to `useUploader`, which counts both kinds, then gate your own controls on `uploader.full`.

`ClearTrigger` has the same blind spot: it empties Zag's list, which reconciles to `setFiles([])` and clears the _picked_ files only. Use `uploader.clear()` when you mean "empty the field".

Rehydrated `CompletedUploadModel`s have no `File`, so they can't go through Zag's `Item` parts and aren't part of its list — render those rows with your own markup. `setFiles` never touches them, so `setFiles([])` clears the picked files without discarding uploads that already exist server-side.

Because the two layers overlap, don't configure the same rule twice. The division follows the same rule as everywhere else: collection-level limits (`maxFiles`) go to the uploader, file-level ones (`accept`, `maxFileSize`) stay on Zag — so leave `accept` and `validate` off the uploader.

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

| Member                                           |                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `uploads`                                        | every upload, in display order                                    |
| `files`                                          | just the `FileModel`s                                             |
| `values` / `ids`                                 | the completed set as `{ id, name }[]` / `string[]`                |
| `progress`                                       | 0–100, byte-weighted across non-failed files                      |
| `uploading` / `failed` / `invalid`               | anything working / anything failed / anything not yet completed   |
| `full` / `remainingSlots`                        | whether `maxFiles` is reached, and how many more will be accepted |
| `errors`                                         | every error currently attached to an upload                       |
| `activeParts` / `queuedParts` / `pendingUploads` | scheduler state                                                   |

Actions: `addFiles`, `setFiles`, `addCompletedUpload`, `applyValue`, `removeUpload`, `clear`, `retryAll`, `pump`, `activate`, `dispose`.

| Adding files      |                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `addFiles(files)` | For a selection layer that reports only what was newly picked — an `<input>` change event, and what `<Uploader.Root>` uses. **Additive in `multiple` mode**, where a file already in the list is skipped. In single-file mode it **replaces**: whatever was there is removed first, so re-picking the same file re-uploads it. |
| `setFiles(files)` | **Reconciling.** For a selection layer that owns the list and reports all of it on every change — Chakra/Ark's `onFileAccept`. Adds, removes and cancels to match; leaves rehydrated uploads alone.                                                                                                                            |

Where they do compare, two `File`s are the same selection when they are the same object, or share a name, size and type — `isSameFile`, the comparison Zag uses. So in `multiple` mode re-picking a file can't produce two uploads of the same bytes, two server-side pending uploads and two entries in the form value; `addFiles` reports the skip through `onError` as `UploadError("REJECTED")` rather than dropping it silently. Files that differ in size or type are unaffected.

### Lifecycle

`useUploader` pairs `activate()`/`dispose()` in an effect. `dispose()` **parks** rather than destroys: it aborts in-flight work, clears timers, revokes preview URLs and drops the `onChange` reaction, but leaves `uploads` in place with resumable statuses. `activate()` picks them back up. That is what makes a StrictMode dev remount — and an uploader owned by a long-lived store — behave sanely instead of restarting every upload.

One consequence: `completeUpload` **must be idempotent**, because parking mid-call means `activate()` re-issues it. An aborted request gives no evidence about whether the server processed it, and re-issuing an idempotent call beats silently dropping an upload.
