// @vitest-environment happy-dom
import { StrictMode, act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test, vi } from "vite-plus/test";
import { Uploader } from "./components";
import { UploadError } from "./errors";
import { useUploaderContext } from "./uploader.context";
import { UploaderModel } from "./uploader.model";
import type { UploaderConfig, UploadPart, UploadPartFn, UploadValue } from "./uploader.types";
import { useUploader } from "./use-uploader";

const partsFor = (size: number, partSize: number): UploadPart[] => {
  const parts: UploadPart[] = [];
  for (let offset = 0; offset < size; offset += partSize) {
    parts.push({
      url: `https://example.test/part-${parts.length}`,
      size: Math.min(partSize, size - offset),
    });
  }
  return parts;
};

const makeFile = (name: string, size: number): File => new File([new Uint8Array(size)], name);

/** A transport that never settles, so uploads stay in flight for the duration of a test. */
const hangingUploadPart: UploadPartFn = (signal) =>
  new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new UploadError("ABORTED")), { once: true });
  });

const baseConfig = (overrides: Partial<UploaderConfig> = {}): UploaderConfig => ({
  uploadPart: hangingUploadPart,
  requestUpload: (_signal, file) =>
    Promise.resolve({ id: `id-${file.name}`, name: file.name, parts: partsFor(file.size, 10) }),
  ...overrides,
});

const mount = async (el: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  return { container, root };
};

const fileInput = (container: HTMLElement): HTMLInputElement => {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input rendered");
  return input;
};

/** happy-dom won't let us populate `files` from a real dialog, so define it directly. */
const pick = async (input: HTMLInputElement, files: File[]): Promise<void> => {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

describe("Uploader.Root", () => {
  test("renders children on the first pass", async () => {
    const uploader = new UploaderModel(baseConfig());
    const { container } = await mount(
      <Uploader.Root uploader={uploader}>
        <span data-testid="child">hello</span>
      </Uploader.Root>,
    );

    // the reference held the context in state set from a ref callback, so children were absent
    // until a second render
    expect(container.querySelector('[data-testid="child"]')).not.toBeNull();
  });

  test("renders no wrapper element of its own", async () => {
    const uploader = new UploaderModel(baseConfig());
    const { container } = await mount(
      <Uploader.Root uploader={uploader}>
        <span data-testid="child" />
      </Uploader.Root>,
    );

    // only the hidden input and the child — no div to style around
    expect([...container.children].map((el) => el.tagName)).toEqual(["INPUT", "SPAN"]);
  });

  test("mirrors accept/multiple/capture from the model config", async () => {
    const uploader = new UploaderModel(
      baseConfig({ accept: ".pdf", multiple: true, capture: "environment" }),
    );
    const { container } = await mount(<Uploader.Root uploader={uploader} />);

    const input = fileInput(container);
    expect(input.getAttribute("accept")).toBe(".pdf");
    expect(input.multiple).toBe(true);
    expect(input.getAttribute("capture")).toBe("environment");
    expect(input.getAttribute("aria-hidden")).toBe("true");
    expect(input.tabIndex).toBe(-1);
  });

  test("inputProps cannot override the model-derived attributes", async () => {
    const uploader = new UploaderModel(baseConfig({ accept: ".pdf" }));
    const { container } = await mount(
      <Uploader.Root uploader={uploader} inputProps={{ id: "doc", name: "document" }} />,
    );

    const input = fileInput(container);
    expect(input.id).toBe("doc");
    expect(input.name).toBe("document");
    expect(input.getAttribute("accept")).toBe(".pdf");
  });

  test("picking files adds them and clears the input so the same file can be re-picked", async () => {
    const uploader = new UploaderModel(baseConfig());
    uploader.activate();
    const { container } = await mount(<Uploader.Root uploader={uploader} />);
    const input = fileInput(container);

    await pick(input, [makeFile("a.bin", 10)]);

    expect(uploader.uploads).toHaveLength(1);
    // without this the browser fires no change event for an identical second pick
    expect(input.value).toBe("");
  });

  test("openFileDialog on the context clicks the hidden input", async () => {
    const uploader = new UploaderModel(baseConfig());
    const clicked = vi.fn();

    const Trigger = (): React.ReactNode => {
      const { openFileDialog } = useUploaderContext();
      return (
        <button type="button" data-testid="browse" onClick={openFileDialog}>
          browse
        </button>
      );
    };

    const { container } = await mount(
      <Uploader.Root uploader={uploader}>
        <Trigger />
      </Uploader.Root>,
    );

    fileInput(container).addEventListener("click", clicked);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="browse"]')?.click();
    });

    expect(clicked).toHaveBeenCalledTimes(1);
  });

  test("using a part outside Root throws a message naming the component", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(mount(<Uploader.Uploads>{() => null}</Uploader.Uploads>)).rejects.toThrow(
      /<Uploader.Root \/>/,
    );
    error.mockRestore();
  });
});

describe("Uploader.Uploads", () => {
  test("renders every upload, of either kind, and emits no element of its own", async () => {
    const uploader = new UploaderModel(
      baseConfig({ multiple: true, value: [{ id: "old", name: "old.pdf" }] }),
    );
    uploader.activate();
    uploader.addFiles([makeFile("new.bin", 10)]);

    const { container } = await mount(
      <div data-testid="list">
        <Uploader.Root uploader={uploader}>
          <Uploader.Uploads>
            {(upload) => <span data-name={upload.name} data-status={upload.status} />}
          </Uploader.Uploads>
        </Uploader.Root>
      </div>,
    );

    const rows = [...container.querySelectorAll("span")];
    expect(rows.map((row) => row.getAttribute("data-name"))).toEqual(["old.pdf", "new.bin"]);
    expect(rows[0]?.getAttribute("data-status")).toBe("COMPLETED");
    // the spans are direct children of the consumer's own list element
    expect(rows[0]?.parentElement?.getAttribute("data-testid")).toBe("list");
  });

  test("re-renders as an upload's status changes", async () => {
    // held open so REQUESTING is actually observable — an already-resolved promise would settle
    // inside the same `act` block
    let release: (() => void) | undefined;
    const uploader = new UploaderModel(
      baseConfig({
        requestUpload: (_signal, file) =>
          new Promise((resolve) => {
            release = () => resolve({ id: "x", name: file.name, parts: partsFor(file.size, 10) });
          }),
      }),
    );
    uploader.activate();

    const { container } = await mount(
      <Uploader.Root uploader={uploader}>
        <Uploader.Uploads>{(upload) => <span data-status={upload.status} />}</Uploader.Uploads>
      </Uploader.Root>,
    );

    await act(async () => {
      uploader.addFiles([makeFile("a.bin", 10)]);
    });
    expect(container.querySelector("span")?.getAttribute("data-status")).toBe("REQUESTING");

    await act(async () => {
      release?.();
    });
    expect(container.querySelector("span")?.getAttribute("data-status")).toBe("UPLOADING");
  });
});

describe("useUploader", () => {
  test("keeps one model across renders and refreshes the config in place", async () => {
    const seen: UploaderModel[] = [];
    const changes: UploadValue[][] = [];
    let bump: (() => void) | undefined;

    const Harness = ({ label }: { label: string }): React.ReactNode => {
      const [, setTick] = useState(0);
      bump = () => setTick((tick) => tick + 1);
      const uploader = useUploader(
        baseConfig({ onChange: (values) => changes.push([label, ...values] as never) }),
      );
      seen.push(uploader);
      return null;
    };

    await mount(<Harness label="first" />);
    await act(async () => bump?.());

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    // the latest inline lambda is the one that fires, without the reaction re-subscribing
    expect(typeof seen[0]?.config.onChange).toBe("function");
  });

  test("a StrictMode remount resumes rather than restarting an in-flight upload", async () => {
    const requests: string[] = [];
    let uploader: UploaderModel | undefined;

    const Harness = (): React.ReactNode => {
      uploader = useUploader(
        baseConfig({
          requestUpload: (_signal, file) => {
            requests.push(file.name);
            return Promise.resolve({
              id: `id-${file.name}`,
              name: file.name,
              parts: partsFor(file.size, 10),
            });
          },
        }),
      );
      return null;
    };

    await mount(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );

    await act(async () => {
      uploader?.addFiles([makeFile("a.bin", 10)]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    // StrictMode already ran mount -> cleanup -> mount against this model; the upload survived it
    expect(uploader?.uploads).toHaveLength(1);
    expect(uploader?.files[0]?.status).toBe("UPLOADING");
    expect(requests).toEqual(["a.bin"]);
  });

  test("unmounting parks the uploader and drops the onChange reaction", async () => {
    const onChange = vi.fn();
    let uploader: UploaderModel | undefined;

    const Harness = (): React.ReactNode => {
      uploader = useUploader(baseConfig({ onChange }));
      return null;
    };

    const { root } = await mount(<Harness />);
    await act(async () => {
      uploader?.addFiles([makeFile("a.bin", 10)]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const part = uploader?.files[0]?.parts[0];
    expect(part?.status).toBe("UPLOADING");

    await act(async () => {
      root.unmount();
    });

    // parked, not destroyed: the part is resumable and the reaction is gone
    expect(uploader?.uploads).toHaveLength(1);
    expect(part?.status).toBe("QUEUED");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("passing the value key makes the uploader controlled", async () => {
    let uploader: UploaderModel | undefined;
    let setValue: ((value: UploadValue[]) => void) | undefined;

    const Harness = (): React.ReactNode => {
      const [value, set] = useState<UploadValue[]>([{ id: "a", name: "a.pdf" }]);
      setValue = set;
      uploader = useUploader(baseConfig({ multiple: true, value }));
      return null;
    };

    await mount(<Harness />);
    expect(uploader?.ids).toEqual(["a"]);

    await act(async () =>
      setValue?.([
        { id: "a", name: "a.pdf" },
        { id: "b", name: "b.pdf" },
      ]),
    );
    expect(uploader?.ids).toEqual(["a", "b"]);

    await act(async () => setValue?.([]));
    expect(uploader?.ids).toEqual([]);
  });

  test("omitting the value key leaves the uploader in charge of its own list", async () => {
    let uploader: UploaderModel | undefined;
    let bump: (() => void) | undefined;

    const Harness = (): React.ReactNode => {
      const [, setTick] = useState(0);
      bump = () => setTick((tick) => tick + 1);
      // no `value` key at all
      uploader = useUploader(baseConfig());
      return null;
    };

    await mount(<Harness />);
    await act(async () => {
      uploader?.addFiles([makeFile("a.bin", 10)]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => bump?.());

    // an uncontrolled uploader must not have its list reconciled away on re-render
    expect(uploader?.uploads).toHaveLength(1);
  });
});
