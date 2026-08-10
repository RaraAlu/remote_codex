import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_INLINE_MENTION_PATH_MARKER,
  CODEX_REMOTE_INLINE_MENTION_PATH_PREFIX,
  CODEX_WEBVIEW_DROP_CHANNEL,
  inspectCodexInlineMentionSource,
} from "../src/extension/codex-inline-mention-patch.js";

const SOURCE = [
  "class Composer{insertAtMention(e,t){this.insertMentionNodeFromAtMention(e,t)}insertMentionNodeInRange(e,t,n,r,i=!1){this.insert(e,t,n,r,i)}}",
  "let controller={view:{dom:{},state:{selection:{from:1,to:1},schema:{nodes:{atMention:{}}}}},insertMentionNodeInRange(){}};",
  "listen(`add-context-file`,controller.view.dom,event=>{focus(),addDescriptors([event.file])});",
].join(";");
const execFileAsync = promisify(execFile);

describe("official Codex inline file mention patch", () => {
  it("routes marked add-context-file events into an inline mention at the current selection", () => {
    const inspected = inspectCodexInlineMentionSource(SOURCE);
    expect(inspected.status).toBe("patchable");
    if (inspected.status !== "patchable") {
      return;
    }
    expect(inspected.patchedSource).toContain(
      "let CodexRemoteBridgeSelection=controller.view.state.selection",
    );
    expect(inspected.patchedSource).toContain(
      "controller.insertAtMention({...CodexRemoteBridgeFile,matchType:",
    );
    expect(inspected.patchedSource).toContain(
      "{range:{from:CodexRemoteBridgeSelection.from,to:CodexRemoteBridgeSelection.to}}",
    );
    expect(inspected.patchedSource).toContain("CodexRemoteBridgeDuplicate=!0");
    expect(inspected.patchedSource).toContain(
      "addDescriptors([CodexRemoteBridgeFile]);return",
    );
    expect(inspected.patchedSource).toContain(
      "globalThis.__codexRemoteBridgeWebviewDropV1=!0",
    );
    expect(inspected.patchedSource).toContain(
      `channel:${JSON.stringify(CODEX_WEBVIEW_DROP_CHANNEL)}`,
    );
    expect(inspectCodexInlineMentionSource(inspected.patchedSource)).toEqual({
      status: "compatible",
    });
  });

  it("passes the current composer selection to the native mention insertion method", () => {
    const runtimeSource = [
      "let captured=null,handler=null",
      "class Composer{constructor(){this.view={dom:{},state:{selection:{from:4,to:9},schema:{nodes:{atMention:'atMention'}},doc:{descendants:()=>{}}}}}insertAtMention(e,t){captured={attrs:e,from:t.range.from,to:t.range.to}}insertMentionNodeInRange(e,t,n,r,i=!1){}}",
      "let controller=new Composer()",
      "let listen=(type,dom,callback)=>{handler=callback},focus=()=>{},addDescriptors=()=>{}",
      "listen(`add-context-file`,controller.view.dom,event=>{focus(),addDescriptors([event.file])});",
    ].join(";");
    const inspected = inspectCodexInlineMentionSource(runtimeSource);
    expect(inspected.status).toBe("patchable");
    if (inspected.status !== "patchable") {
      return;
    }

    const evaluate = new Function(
      `${inspected.patchedSource};handler({file:{label:'main.py${CODEX_INLINE_MENTION_PATH_MARKER}',path:'/work/main.py${CODEX_INLINE_MENTION_PATH_MARKER}',fsPath:'/work/main.py${CODEX_INLINE_MENTION_PATH_MARKER}'}});return captured;`,
    ) as () => unknown;
    expect(evaluate()).toEqual({
      attrs: {
        label: "main.py",
        path: "/work/main.py",
        fsPath: "/work/main.py",
        matchType: "file",
      },
      from: 4,
      to: 9,
    });
  });

  it("removes the transport marker before inserting a directory mention", () => {
    const runtimeSource = [
      "let captured=null,handler=null",
      "class Composer{constructor(){this.view={dom:{},state:{selection:{from:3,to:3},schema:{nodes:{atMention:'atMention'}},doc:{descendants:()=>{}}}}}insertAtMention(e,t){captured={attrs:e,range:t.range}}insertMentionNodeInRange(e,t,n,r,i=!1){}}",
      "let controller=new Composer()",
      "let listen=(type,dom,callback)=>{handler=callback},focus=()=>{},addDescriptors=()=>{}",
      "listen(`add-context-file`,controller.view.dom,event=>{focus(),addDescriptors([event.file])});",
    ].join(";");
    const inspected = inspectCodexInlineMentionSource(runtimeSource);
    expect(inspected.status).toBe("patchable");
    if (inspected.status !== "patchable") {
      return;
    }

    const evaluate = new Function(
      `${inspected.patchedSource};handler({file:{label:'src${CODEX_INLINE_MENTION_PATH_MARKER}',path:'/work/src${CODEX_INLINE_MENTION_PATH_MARKER}/',fsPath:'/work/src${CODEX_INLINE_MENTION_PATH_MARKER}/'}});return captured;`,
    ) as () => unknown;
    expect(evaluate()).toEqual({
      attrs: {
        label: "src",
        path: "/work/src/",
        fsPath: "/work/src/",
        matchType: "directory",
      },
      range: { from: 3, to: 3 },
    });
  });

  it("decodes a platform-neutral Remote SSH path before inserting the mention", () => {
    const runtimeSource = [
      "let captured=null,handler=null",
      "class Composer{constructor(){this.view={dom:{},state:{selection:{from:2,to:2},schema:{nodes:{atMention:'atMention'}},doc:{descendants:()=>{}}}}}insertAtMention(e,t){captured={attrs:e,range:t.range}}insertMentionNodeInRange(e,t,n,r,i=!1){}}",
      "let controller=new Composer()",
      "let listen=(type,dom,callback)=>{handler=callback},focus=()=>{},addDescriptors=()=>{}",
      "listen(`add-context-file`,controller.view.dom,event=>{focus(),addDescriptors([event.file])});",
    ].join(";");
    const inspected = inspectCodexInlineMentionSource(runtimeSource);
    expect(inspected.status).toBe("patchable");
    if (inspected.status !== "patchable") {
      return;
    }
    const encoded = encodeURIComponent("/home/unitree/project/src/main.py");
    const transport = `\\\\${CODEX_REMOTE_INLINE_MENTION_PATH_PREFIX}${encoded}${CODEX_INLINE_MENTION_PATH_MARKER}`;
    const evaluate = new Function(
      `${inspected.patchedSource};handler({file:{label:'transport',path:${JSON.stringify(transport)},fsPath:${JSON.stringify(transport)}}});return captured;`,
    ) as () => unknown;

    expect(evaluate()).toEqual({
      attrs: {
        label: "main.py",
        path: "/home/unitree/project/src/main.py",
        fsPath: "/home/unitree/project/src/main.py",
        matchType: "file",
      },
      range: { from: 2, to: 2 },
    });
  });

  it("preserves the official attachment path for unmarked files", () => {
    const runtimeSource = [
      "let added=null,handler=null",
      "class Composer{insertAtMention(e,t){throw new Error('unexpected inline mention')}insertMentionNodeInRange(e,t,n,r,i=!1){}}",
      "let controller=new Composer();controller.view={dom:{},state:{selection:{from:1,to:1},schema:{nodes:{atMention:'atMention'}},doc:{descendants:()=>{}}}}",
      "let listen=(type,dom,callback)=>{handler=callback},focus=()=>{},addDescriptors=value=>{added=value}",
      "listen(`add-context-file`,controller.view.dom,event=>{focus(),addDescriptors([event.file])});",
    ].join(";");
    const inspected = inspectCodexInlineMentionSource(runtimeSource);
    expect(inspected.status).toBe("patchable");
    if (inspected.status !== "patchable") {
      return;
    }

    const evaluate = new Function(
      `${inspected.patchedSource};let file={label:'outside.txt',path:'/tmp/outside.txt',fsPath:'/tmp/outside.txt'};handler({file});return added;`,
    ) as () => unknown;
    expect(evaluate()).toEqual([
      {
        label: "outside.txt",
        path: "/tmp/outside.txt",
        fsPath: "/tmp/outside.txt",
      },
    ]);
  });

  it("forwards a direct Webview ingress and fallback drop to the Workbench", () => {
    const runtimeSource = [
      "let handler=null",
      "class Composer{insertAtMention(e,t){}insertMentionNodeInRange(e,t,n,r,i=!1){}}",
      "let controller=new Composer();controller.view={dom:{},state:{selection:{from:1,to:1},schema:{nodes:{atMention:'atMention'}},doc:{descendants:()=>{}}}}",
      "let listen=(type,dom,callback)=>{handler=callback},focus=()=>{},addDescriptors=()=>{}",
      "listen(`add-context-file`,controller.view.dom,event=>{focus(),addDescriptors([event.file])});",
    ].join(";");
    const inspected = inspectCodexInlineMentionSource(runtimeSource);
    expect(inspected.status).toBe("patchable");
    if (inspected.status !== "patchable") {
      return;
    }

    const runtime = globalThis as typeof globalThis & Record<string, unknown>;
    const propertyNames = [
      "__codexRemoteBridgeWebviewDropV1",
      "addEventListener",
      "electronBridge",
      "top",
    ];
    const descriptors = new Map(
      propertyNames.map((name) => [name, Object.getOwnPropertyDescriptor(runtime, name)]),
    );
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const postMessage = vi.fn();
    try {
      Object.defineProperties(runtime, {
        __codexRemoteBridgeWebviewDropV1: {
          configurable: true,
          value: false,
          writable: true,
        },
        addEventListener: {
          configurable: true,
          value: (name: string, listener: (event: Record<string, unknown>) => void) =>
            listeners.set(name, listener),
          writable: true,
        },
        electronBridge: {
          configurable: true,
          value: { getPathForFile: () => "/home/test/Documents/manual.pdf" },
          writable: true,
        },
        top: {
          configurable: true,
          value: { postMessage },
          writable: true,
        },
      });
      new Function(inspected.patchedSource)();

      const preventDefault = vi.fn();
      listeners.get("dragenter")?.({
        dataTransfer: { dropEffect: "none", files: [], types: [] },
        preventDefault,
        stopImmediatePropagation: vi.fn(),
        stopPropagation: vi.fn(),
      });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith(
        { channel: CODEX_WEBVIEW_DROP_CHANNEL, phase: "dragenter" },
        "*",
      );

      listeners.get("drop")?.({
        dataTransfer: {
          files: [{}],
          getData: (type: string) =>
            type === "text/uri-list" ? "file:///home/test/Documents/manual.pdf" : "",
          types: ["Files", "text/uri-list"],
        },
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        stopPropagation: vi.fn(),
      });
      expect(postMessage).toHaveBeenLastCalledWith(
        {
          channel: CODEX_WEBVIEW_DROP_CHANNEL,
          payload: expect.objectContaining({
            nativeFilePaths: ["/home/test/Documents/manual.pdf"],
            uriList: "file:///home/test/Documents/manual.pdf",
          }),
          phase: "drop",
        },
        "*",
      );
    } finally {
      for (const name of propertyNames) {
        const descriptor = descriptors.get(name);
        if (descriptor) {
          Object.defineProperty(runtime, name, descriptor);
        } else {
          delete runtime[name];
        }
      }
    }
  });

  it("does not insert a path that is already mentioned in the composer", () => {
    const runtimeSource = [
      "let inserted=0,handler=null",
      "class Composer{constructor(){this.view={dom:{},state:{selection:{from:2,to:2},schema:{nodes:{atMention:'atMention'}},doc:{descendants:callback=>callback({type:'atMention',attrs:{path:'/work/main.py',fsPath:'/work/main.py'}})}}}}insertAtMention(e,t){inserted+=1}insertMentionNodeInRange(e,t,n,r,i=!1){}}",
      "let controller=new Composer()",
      "let listen=(type,dom,callback)=>{handler=callback},focus=()=>{},addDescriptors=()=>{}",
      "listen(`add-context-file`,controller.view.dom,event=>{focus(),addDescriptors([event.file])});",
    ].join(";");
    const inspected = inspectCodexInlineMentionSource(runtimeSource);
    expect(inspected.status).toBe("patchable");
    if (inspected.status !== "patchable") {
      return;
    }
    const evaluate = new Function(
      `${inspected.patchedSource};handler({file:{label:'main.py${CODEX_INLINE_MENTION_PATH_MARKER}',path:'/work/main.py${CODEX_INLINE_MENTION_PATH_MARKER}',fsPath:'/work/main.py${CODEX_INLINE_MENTION_PATH_MARKER}'}});return inserted;`,
    ) as () => unknown;
    expect(evaluate()).toBe(0);
  });

  it("fails closed when the official handler shape changes", () => {
    expect(
      inspectCodexInlineMentionSource(
        SOURCE.replace("addDescriptors([event.file])", "addDescriptors(event.file)"),
      ),
    ).toEqual({
      status: "unsupported",
      detail: "expected one Codex add-context-file composer handler, found 0",
    });
  });

  it("rejects malformed managed markers", () => {
    expect(
      inspectCodexInlineMentionSource(
        `${SOURCE}/* codex-remote-bridge-inline-file-mention:v1:start */`,
      ),
    ).toEqual({
      status: "unsupported",
      detail: "managed inline mention markers are malformed",
    });
  });

  const installedAsset = join(
    process.env.HOME ?? "",
    ".vscode",
    "extensions",
    "openai.chatgpt-26.803.41515-linux-x64",
    "webview",
    "assets",
    "app-initial-Ge3MuNyY.js",
  );
  const managedOriginalAsset = join(
    process.env.HOME ?? "",
    ".local",
    "state",
    "codex-remote-bridge",
    "codex-inline-mention-compatibility",
    "inline-file-mention.original.js",
  );
  it.skipIf(!existsSync(installedAsset))(
    "recognizes and preserves JavaScript syntax for the installed official asset",
    async () => {
      const source = await readFile(
        existsSync(managedOriginalAsset) ? managedOriginalAsset : installedAsset,
        "utf8",
      );
      const inspected = inspectCodexInlineMentionSource(source);
      expect(inspected.status).toMatch(/patchable|compatible/);
      if (inspected.status !== "patchable") {
        return;
      }
      const root = await mkdtemp(join(tmpdir(), "codex-inline-mention-"));
      const modulePath = join(root, "asset.mjs");
      try {
        await writeFile(modulePath, inspected.patchedSource, "utf8");
        await expect(
          execFileAsync(process.execPath, ["--check", modulePath]),
        ).resolves.toBeDefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
