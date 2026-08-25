const PATCH_MARKER = "codex-remote-bridge-inline-file-mention:v1";
const PATCH_START = `/* ${PATCH_MARKER}:start */`;
const PATCH_END = `/* ${PATCH_MARKER}:end */`;

export const CODEX_INLINE_MENTION_PATH_MARKER =
  ".__codex_remote_bridge_inline_6b9f5d70f1d84a5f__";
export const CODEX_REMOTE_INLINE_MENTION_PATH_PREFIX =
  ".__codex_remote_bridge_remote_3c4ca1f4b3d74649__";
export const CODEX_WEBVIEW_DROP_CHANNEL =
  "codex-remote-bridge-webview-drop-v1";

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const ADD_CONTEXT_FILE_HANDLER = new RegExp(
  `(${IDENTIFIER})\\(\`add-context-file\`,(${IDENTIFIER})\\.view\\.dom,(${IDENTIFIER})=>\\{(${IDENTIFIER})\\(\\),(${IDENTIFIER})\\(\\[\\3\\.file\\]\\)\\}\\);`,
  "g",
);
const INSERT_MENTION_METHOD = new RegExp(
  `insertMentionNodeInRange\\((${IDENTIFIER}),(${IDENTIFIER}),(${IDENTIFIER}),(${IDENTIFIER})(?:,${IDENTIFIER}(?:=[^,)]*)?){0,4}\\)\\{`,
  "g",
);
const INSERT_AT_MENTION_METHOD = new RegExp(
  `insertAtMention\\((${IDENTIFIER}),(${IDENTIFIER})\\)\\{`,
  "g",
);

export type CodexInlineMentionSourceInspection =
  | { status: "compatible" }
  | { status: "patchable"; patchedSource: string }
  | { status: "unsupported"; detail: string };

function matches(source: string, pattern: RegExp): RegExpExecArray[] {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

export function inspectCodexInlineMentionSource(
  source: string,
): CodexInlineMentionSourceInspection {
  const startCount = source.split(PATCH_START).length - 1;
  const endCount = source.split(PATCH_END).length - 1;
  if (startCount > 0 || endCount > 0) {
    return startCount === 1 && endCount === 1
      ? { status: "compatible" }
      : {
          status: "unsupported",
          detail: "managed inline mention markers are malformed",
        };
  }

  const handlers = matches(source, ADD_CONTEXT_FILE_HANDLER);
  if (handlers.length !== 1) {
    return {
      status: "unsupported",
      detail: `expected one Codex add-context-file composer handler, found ${handlers.length}`,
    };
  }
  if (matches(source, INSERT_MENTION_METHOD).length !== 1) {
    return {
      status: "unsupported",
      detail: "Codex composer does not expose the expected inline mention insertion capability",
    };
  }
  if (matches(source, INSERT_AT_MENTION_METHOD).length !== 1) {
    return {
      status: "unsupported",
      detail: "Codex composer does not expose the expected native at-mention capability",
    };
  }

  const handler = handlers[0];
  const handlerSource = handler?.[0];
  const handlerIndex = handler?.index;
  const receiver = handler?.[1];
  const composer = handler?.[2];
  const event = handler?.[3];
  const focusComposer = handler?.[4];
  const addDescriptors = handler?.[5];
  if (
    !handlerSource ||
    handlerIndex === undefined ||
    !receiver ||
    !composer ||
    !event ||
    !focusComposer ||
    !addDescriptors
  ) {
    return {
      status: "unsupported",
      detail: "Codex add-context-file composer handler is malformed",
    };
  }

  const webviewIngress = [
    PATCH_START,
    "if(typeof globalThis.addEventListener===\"function\"&&!globalThis.__codexRemoteBridgeWebviewDropV1){",
    "globalThis.__codexRemoteBridgeWebviewDropV1=!0;",
    "let CodexRemoteBridgePostDrop=(CodexRemoteBridgePhase,CodexRemoteBridgeEvent)=>{",
    "let CodexRemoteBridgeTransfer=CodexRemoteBridgeEvent.dataTransfer;",
    "if(!CodexRemoteBridgeTransfer)return;",
    "let CodexRemoteBridgeTypes=Array.from(CodexRemoteBridgeTransfer.types??[],CodexRemoteBridgeType=>String(CodexRemoteBridgeType).toLowerCase()),",
    "CodexRemoteBridgeSupported=[\"application/vnd.code.uri-list\",\"text/uri-list\",\"resourceurls\",\"codefiles\",\"files\"].some(CodexRemoteBridgeType=>CodexRemoteBridgeTypes.includes(CodexRemoteBridgeType));",
    "if(CodexRemoteBridgePhase!==\"drop\"){",
    "if(!CodexRemoteBridgeSupported&&CodexRemoteBridgeTypes.length!==0)return;",
    "CodexRemoteBridgeEvent.preventDefault();CodexRemoteBridgeEvent.stopPropagation();",
    "typeof CodexRemoteBridgeEvent.stopImmediatePropagation===\"function\"&&CodexRemoteBridgeEvent.stopImmediatePropagation();",
    "if(CodexRemoteBridgeTransfer)try{CodexRemoteBridgeTransfer.dropEffect=\"copy\"}catch{}",
    "try{globalThis.top?.postMessage({channel:" +
      JSON.stringify(CODEX_WEBVIEW_DROP_CHANNEL) +
      ",phase:CodexRemoteBridgePhase},\"*\")}catch{}",
    "return",
    "}",
    "let CodexRemoteBridgeGet=CodexRemoteBridgeType=>{try{return CodexRemoteBridgeTransfer.getData(CodexRemoteBridgeType)||void 0}catch{return}},CodexRemoteBridgePaths=[];",
    "if(CodexRemoteBridgeTransfer.files)for(let CodexRemoteBridgeNativeFile of Array.from(CodexRemoteBridgeTransfer.files)){",
    "let CodexRemoteBridgeNativePath=globalThis.electronBridge?.getPathForFile?.(CodexRemoteBridgeNativeFile);",
    "if(!(typeof CodexRemoteBridgeNativePath===\"string\"&&CodexRemoteBridgeNativePath.length>0)&&\"path\" in CodexRemoteBridgeNativeFile&&typeof CodexRemoteBridgeNativeFile.path===\"string\")CodexRemoteBridgeNativePath=CodexRemoteBridgeNativeFile.path;",
    "typeof CodexRemoteBridgeNativePath===\"string\"&&CodexRemoteBridgeNativePath.length>0&&CodexRemoteBridgePaths.push(CodexRemoteBridgeNativePath)",
    "}",
    "let CodexRemoteBridgePayload={schemaVersion:1,internalUriList:CodexRemoteBridgeGet(\"application/vnd.code.uri-list\"),uriList:CodexRemoteBridgeGet(\"text/uri-list\"),resourceUrls:CodexRemoteBridgeGet(\"ResourceURLs\"),codeFiles:CodexRemoteBridgeGet(\"CodeFiles\"),nativeFilePaths:CodexRemoteBridgePaths};",
    "if(!(CodexRemoteBridgePayload.internalUriList||CodexRemoteBridgePayload.uriList||CodexRemoteBridgePayload.resourceUrls||CodexRemoteBridgePayload.codeFiles||CodexRemoteBridgePayload.nativeFilePaths.length))return;",
    "CodexRemoteBridgeEvent.preventDefault();CodexRemoteBridgeEvent.stopPropagation();",
    "typeof CodexRemoteBridgeEvent.stopImmediatePropagation===\"function\"&&CodexRemoteBridgeEvent.stopImmediatePropagation();",
    "try{globalThis.top?.postMessage({channel:" +
      JSON.stringify(CODEX_WEBVIEW_DROP_CHANNEL) +
      ",phase:\"drop\",payload:CodexRemoteBridgePayload},\"*\")}catch{}",
    "};",
    "for(let CodexRemoteBridgeDropEvent of [\"dragenter\",\"dragover\",\"drop\"])globalThis.addEventListener(CodexRemoteBridgeDropEvent,CodexRemoteBridgeEvent=>CodexRemoteBridgePostDrop(CodexRemoteBridgeDropEvent,CodexRemoteBridgeEvent),!0)",
    "}",
  ].join("");

  const patchedHandler = [
    `${receiver}(\`add-context-file\`,${composer}.view.dom,${event}=>{`,
    `${focusComposer}();`,
    `let CodexRemoteBridgeFile=${event}.file,`,
    `CodexRemoteBridgeMarker=${JSON.stringify(CODEX_INLINE_MENTION_PATH_MARKER)},`,
    `CodexRemoteBridgeRemotePrefix=${JSON.stringify(CODEX_REMOTE_INLINE_MENTION_PATH_PREFIX)},`,
    "CodexRemoteBridgeIsRemote=CodexRemoteBridgeValue=>{",
    "let CodexRemoteBridgeSeparator=/[\\\\/]$/.test(CodexRemoteBridgeValue)?CodexRemoteBridgeValue.slice(-1):\"\",",
    "CodexRemoteBridgeBody=CodexRemoteBridgeSeparator?CodexRemoteBridgeValue.slice(0,-1):CodexRemoteBridgeValue;",
    "if(!CodexRemoteBridgeBody.endsWith(CodexRemoteBridgeMarker))return!1;",
    "let CodexRemoteBridgeClean=CodexRemoteBridgeBody.slice(0,-CodexRemoteBridgeMarker.length),",
    "CodexRemoteBridgeLeaf=CodexRemoteBridgeClean.slice(Math.max(CodexRemoteBridgeClean.lastIndexOf(\"/\"),CodexRemoteBridgeClean.lastIndexOf(\"\\\\\"))+1);",
    "return CodexRemoteBridgeLeaf.startsWith(CodexRemoteBridgeRemotePrefix)",
    "},",
    "CodexRemoteBridgeCleanPath=CodexRemoteBridgeValue=>{",
    "let CodexRemoteBridgeSeparator=/[\\\\/]$/.test(CodexRemoteBridgeValue)?CodexRemoteBridgeValue.slice(-1):\"\",",
    "CodexRemoteBridgeBody=CodexRemoteBridgeSeparator?CodexRemoteBridgeValue.slice(0,-1):CodexRemoteBridgeValue;",
    "if(!CodexRemoteBridgeBody.endsWith(CodexRemoteBridgeMarker))return null;",
    "let CodexRemoteBridgeClean=CodexRemoteBridgeBody.slice(0,-CodexRemoteBridgeMarker.length),",
    "CodexRemoteBridgeLeaf=CodexRemoteBridgeClean.slice(Math.max(CodexRemoteBridgeClean.lastIndexOf(\"/\"),CodexRemoteBridgeClean.lastIndexOf(\"\\\\\"))+1);",
    "if(CodexRemoteBridgeLeaf.startsWith(CodexRemoteBridgeRemotePrefix)){",
    "try{let CodexRemoteBridgeDecoded=decodeURIComponent(CodexRemoteBridgeLeaf.slice(CodexRemoteBridgeRemotePrefix.length));",
    "if(!CodexRemoteBridgeDecoded.startsWith(\"/\")||CodexRemoteBridgeDecoded.includes(\"\\0\"))return null;",
    "return CodexRemoteBridgeDecoded.replace(/\\/+$/,\"\")+(CodexRemoteBridgeSeparator?\"/\":\"\")}catch{return null}",
    "}",
    "return CodexRemoteBridgeClean+CodexRemoteBridgeSeparator",
    "},",
    "CodexRemoteBridgeWasRemote=CodexRemoteBridgeIsRemote(CodexRemoteBridgeFile.path)||CodexRemoteBridgeIsRemote(CodexRemoteBridgeFile.fsPath),",
    "CodexRemoteBridgePath=CodexRemoteBridgeCleanPath(CodexRemoteBridgeFile.path),",
    "CodexRemoteBridgeFsPath=CodexRemoteBridgeCleanPath(CodexRemoteBridgeFile.fsPath);",
    "if(CodexRemoteBridgePath===null||CodexRemoteBridgeFsPath===null){",
    `${addDescriptors}([CodexRemoteBridgeFile]);return`,
    "}",
    "CodexRemoteBridgeFile={...CodexRemoteBridgeFile,",
    "label:CodexRemoteBridgeWasRemote?CodexRemoteBridgePath.replace(/[\\\\/]$/,\"\").split(/[\\\\/]/).pop():CodexRemoteBridgeFile.label.endsWith(CodexRemoteBridgeMarker)?CodexRemoteBridgeFile.label.slice(0,-CodexRemoteBridgeMarker.length):CodexRemoteBridgeFile.label,",
    "path:CodexRemoteBridgePath,fsPath:CodexRemoteBridgeFsPath};",
    "let CodexRemoteBridgeDuplicate=!1;",
    `${composer}.view.state.doc.descendants(CodexRemoteBridgeNode=>{`,
    `CodexRemoteBridgeNode.type===${composer}.view.state.schema.nodes.atMention&&`,
    `(CodexRemoteBridgeNode.attrs.fsPath===CodexRemoteBridgeFile.fsPath||`,
    `CodexRemoteBridgeNode.attrs.path===CodexRemoteBridgeFile.path)&&`,
    `(CodexRemoteBridgeDuplicate=!0)`,
    "});",
    "if(!CodexRemoteBridgeDuplicate){",
    `let CodexRemoteBridgeSelection=${composer}.view.state.selection;`,
    `${composer}.insertAtMention(`,
    "{...CodexRemoteBridgeFile,matchType:/[\\\\/]$/.test(CodexRemoteBridgeFile.path)?\"directory\":\"file\"},",
    "{range:{from:CodexRemoteBridgeSelection.from,to:CodexRemoteBridgeSelection.to}}",
    ")",
    "}",
    ";",
    "});",
    PATCH_END,
  ].join("");

  return {
    status: "patchable",
    patchedSource:
      source.slice(0, handlerIndex) +
      webviewIngress +
      patchedHandler +
      source.slice(handlerIndex + handlerSource.length),
  };
}
