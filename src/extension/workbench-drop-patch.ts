import { CODEX_WEBVIEW_DROP_CHANNEL } from "./codex-inline-mention-patch.js";

const PATCH_MARKER = "codex-remote-bridge-workbench-drop:v1";
const PATCH_START = `/* ${PATCH_MARKER}:start */`;
const PATCH_END = `/* ${PATCH_MARKER}:end */`;

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const VIEW_ID_ANCHOR = new RegExp(
  `this\\.id=(${IDENTIFIER})\\.id,this\\._title=`,
  "g",
);
const COMMAND_SERVICE_ANCHOR = new RegExp(
  `(${IDENTIFIER})=class extends ${IDENTIFIER}\\{constructor\\(([^)]*)\\)\\{super\\([^}]{0,300}?this\\.commandService=(${IDENTIFIER})\\}static\\{this\\.ID="workbench\\.action\\.closeActiveEditor"\\}[^;]{0,1000}?\\};\\1=(${IDENTIFIER})\\(\\[(${IDENTIFIER})\\(2,(${IDENTIFIER})\\)\\],\\1\\);`,
  "g",
);
const CONTRIBUTION_ANCHOR = new RegExp(
  `(${IDENTIFIER})=class extends ${IDENTIFIER}\\{[^]{0,10000}?static\\{this\\.ID="workbench\\.contrib\\.systemWideKeybindings"\\}[^]{0,10000}?\\};\\1=(${IDENTIFIER})\\(\\[([^\\]]*)\\],\\1\\);(${IDENTIFIER})\\(\\1\\.ID,\\1,(${IDENTIFIER})\\.AfterRestored\\);`,
  "g",
);
const MAIN_EXPORT_ANCHOR = new RegExp(`export\\{${IDENTIFIER} as main\\};`, "g");

interface WorkbenchSymbols {
  commandService: string;
  decorate: string;
  lifecycle: string;
  param: string;
  registerContribution: string;
}

export type WorkbenchDropSourceInspection =
  | { status: "compatible" }
  | { status: "patchable"; patchedSource: string }
  | { status: "unsupported"; detail: string };

function matches(source: string, pattern: RegExp): RegExpExecArray[] {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

function singleMatch(
  source: string,
  pattern: RegExp,
  description: string,
): RegExpExecArray | { detail: string } {
  const found = matches(source, pattern);
  return found.length === 1
    ? found[0]!
    : { detail: `expected one ${description}, found ${found.length}` };
}

function isFailure(value: RegExpExecArray | { detail: string }): value is { detail: string } {
  return "detail" in value;
}

function injectedContribution(symbols: WorkbenchSymbols): string {
  return `${PATCH_START}
var CodexRemoteBridgeWorkbenchDrop=class{
static{this.ID="workbench.contrib.codexRemoteBridgeDrop"}
constructor(e){this.commandService=e;this.overlay=void 0;this.activePane=void 0;this.hideTimer=void 0;this.lastTrace=0;this.lastPayload=void 0;this.lastPayloadAt=0;document.addEventListener("dragenter",t=>this.onDragEnter(t),!0);document.addEventListener("dragover",t=>this.onDragOver(t),!0);document.addEventListener("dragleave",t=>this.onDragLeave(t),!0);document.addEventListener("dragend",()=>this.hide(),!0);document.addEventListener("drop",t=>this.onDrop(t),!0);window.addEventListener("message",t=>this.onWebviewMessage(t),!0);console.info("[Codex Remote Bridge] Workbench drop contribution active")}
paneFromEvent(e){let t=typeof e.composedPath==="function"?e.composedPath():[];for(let i of t){if(i===this.overlay&&this.activePane)return this.activePane;if(i instanceof HTMLElement){let n=i.dataset?.codexBridgeViewId;if(n==="chatgpt.sidebarSecondaryView"||n==="chatgpt.sidebarView")return i}}let r=e.target instanceof Element?e.target.closest('[data-codex-bridge-view-id="chatgpt.sidebarSecondaryView"],[data-codex-bridge-view-id="chatgpt.sidebarView"]'):null;if(r instanceof HTMLElement)return r;let o=Number(e.clientX),a=Number(e.clientY),s=Number.isFinite(o)&&Number.isFinite(a)&&o>=0&&a>=0?document.elementFromPoint?.(o,a):null,l=s instanceof Element?s.closest('[data-codex-bridge-view-id="chatgpt.sidebarSecondaryView"],[data-codex-bridge-view-id="chatgpt.sidebarView"]'):null;if(l instanceof HTMLElement)return l;if(Number.isFinite(o)&&Number.isFinite(a))for(let i of document.querySelectorAll('[data-codex-bridge-view-id="chatgpt.sidebarSecondaryView"],[data-codex-bridge-view-id="chatgpt.sidebarView"]'))if(i instanceof HTMLElement){let n=i.getBoundingClientRect();if(o>=n.left&&o<=n.right&&a>=n.top&&a<=n.bottom)return i}return}
trace(e,t,i){let n=Date.now();if(e!=="drop"&&n-this.lastTrace<500)return;this.lastTrace=n;console.info("[Codex Remote Bridge] Workbench drop "+e,{types:Array.from(t.dataTransfer?.types??[]),pane:i?.dataset?.codexBridgeViewId??null,x:t.clientX,y:t.clientY})}
types(e){return Array.from(e?.types??[],t=>String(t).toLowerCase())}
supported(e){let t=this.types(e);return["application/vnd.code.uri-list","text/uri-list","resourceurls","codefiles","files"].some(i=>t.includes(i))}
candidate(e){return!!e&&(this.supported(e)||this.types(e).length===0)}
accept(e){e.preventDefault();e.stopPropagation();if(e.dataTransfer)try{e.dataTransfer.dropEffect="copy"}catch{}}
show(e){this.activePane=e;this.hideTimer!==void 0&&(clearTimeout(this.hideTimer),this.hideTimer=void 0);let t=e.querySelector(".pane-body")??e,i=t.getBoundingClientRect();this.overlay||(this.overlay=document.createElement("div"),this.overlay.textContent="添加到当前 Codex 对话",this.overlay.setAttribute("aria-hidden","true"),this.overlay.dataset.codexBridgeDropOverlay="true",this.overlay.style.cssText="position:fixed;display:flex;align-items:center;justify-content:center;box-sizing:border-box;pointer-events:auto;z-index:10000;border:2px solid var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-sideBar-background) 88%,transparent);color:var(--vscode-foreground);font:var(--vscode-font-size)/1.4 var(--vscode-font-family);",document.body.appendChild(this.overlay));Object.assign(this.overlay.style,{display:"flex",left:i.left+"px",top:i.top+"px",width:i.width+"px",height:i.height+"px"})}
hideSoon(){this.hideTimer!==void 0&&clearTimeout(this.hideTimer);this.hideTimer=setTimeout(()=>this.hide(),1500)}
hide(){this.hideTimer!==void 0&&(clearTimeout(this.hideTimer),this.hideTimer=void 0);this.overlay&&(this.overlay.style.display="none");this.activePane=void 0}
onDragEnter(e){let t=this.paneFromEvent(e);this.trace("enter",e,t);if(!t||!this.candidate(e.dataTransfer))return;this.show(t);this.accept(e)}
onDragOver(e){let t=this.paneFromEvent(e);this.trace("over",e,t);if(!t||!this.candidate(e.dataTransfer))return;this.show(t);this.accept(e)}
onDragLeave(e){if(!this.activePane)return;let t=e.relatedTarget;if(t instanceof Node&&(this.activePane.contains(t)||this.overlay?.contains(t)))return;this.hideSoon()}
payload(e){let t=e.dataTransfer;if(!t)return;let i=n=>{try{return t.getData(n)||void 0}catch{return}},r=[];if(t.files)for(let n of Array.from(t.files)){let a=globalThis.vscode?.webUtils?.getPathForFile?.(n);typeof a==="string"&&a.length>0&&r.push(a)}let o={schemaVersion:1,internalUriList:i("application/vnd.code.uri-list"),uriList:i("text/uri-list"),resourceUrls:i("ResourceURLs"),codeFiles:i("CodeFiles"),nativeFilePaths:r};return o.internalUriList||o.uriList||o.resourceUrls||o.codeFiles||o.nativeFilePaths.length?o:void 0}
singleVisiblePane(){let e=[];for(let t of document.querySelectorAll('[data-codex-bridge-view-id="chatgpt.sidebarSecondaryView"],[data-codex-bridge-view-id="chatgpt.sidebarView"]'))if(t instanceof HTMLElement){let i=t.getBoundingClientRect();i.width>0&&i.height>0&&e.push(t)}return e.length===1?e[0]:void 0}
messagePayload(e){if(!e||typeof e!=="object"||e.schemaVersion!==1||!Array.isArray(e.nativeFilePaths))return;return typeof e.internalUriList==="string"||typeof e.uriList==="string"||typeof e.resourceUrls==="string"||typeof e.codeFiles==="string"||e.nativeFilePaths.some(t=>typeof t==="string"&&t.length>0)?e:void 0}
deliver(e){let t=JSON.stringify(e),i=Date.now();if(t===this.lastPayload&&i-this.lastPayloadAt<750)return;this.lastPayload=t;this.lastPayloadAt=i;Promise.resolve(this.commandService.executeCommand("codexRemoteBridge.acceptWorkbenchDrop",e)).catch(n=>console.error("[Codex Remote Bridge] Workbench drop failed",n))}
onWebviewMessage(e){let t=e.data;if(!t||t.channel!==${JSON.stringify(CODEX_WEBVIEW_DROP_CHANNEL)})return;let i=this.singleVisiblePane();console.info("[Codex Remote Bridge] Codex Webview drop "+String(t.phase),{pane:i?.dataset?.codexBridgeViewId??null});if(!i)return;if(t.phase==="dragenter"||t.phase==="dragover"){this.show(i);return}if(t.phase!=="drop")return;let n=this.messagePayload(t.payload);this.hide();n&&this.deliver(n)}
onDrop(e){let t=this.paneFromEvent(e),i=t?this.payload(e):void 0;this.trace("drop",e,t);if(!t||!i){this.hide();return}this.accept(e);typeof e.stopImmediatePropagation==="function"&&e.stopImmediatePropagation();this.hide();this.deliver(i)}
};
CodexRemoteBridgeWorkbenchDrop=${symbols.decorate}([${symbols.param}(0,${symbols.commandService})],CodexRemoteBridgeWorkbenchDrop);${symbols.registerContribution}(CodexRemoteBridgeWorkbenchDrop.ID,CodexRemoteBridgeWorkbenchDrop,${symbols.lifecycle}.AfterRestored);
${PATCH_END}
`;
}

export function inspectWorkbenchDropSource(source: string): WorkbenchDropSourceInspection {
  const markerCount = source.split(PATCH_START).length - 1;
  if (markerCount > 0) {
    const endCount = source.split(PATCH_END).length - 1;
    return markerCount === 1 && endCount === 1
      ? { status: "compatible" }
      : { status: "unsupported", detail: "managed Workbench drop markers are malformed" };
  }

  const view = singleMatch(source, VIEW_ID_ANCHOR, "ViewPane identity anchor");
  if (isFailure(view)) {
    return { status: "unsupported", detail: view.detail };
  }
  const command = singleMatch(source, COMMAND_SERVICE_ANCHOR, "command service anchor");
  if (isFailure(command)) {
    return { status: "unsupported", detail: command.detail };
  }
  const contribution = singleMatch(
    source,
    CONTRIBUTION_ANCHOR,
    "Workbench contribution anchor",
  );
  if (isFailure(contribution)) {
    return { status: "unsupported", detail: contribution.detail };
  }
  const mainExport = singleMatch(source, MAIN_EXPORT_ANCHOR, "Workbench main export");
  if (isFailure(mainExport) || mainExport.index === undefined) {
    return {
      status: "unsupported",
      detail: isFailure(mainExport) ? mainExport.detail : "Workbench main export has no offset",
    };
  }

  const viewSource = view[0];
  const viewArgument = view[1];
  const decorate = command[4];
  const param = command[5];
  const commandService = command[6];
  const registerContribution = contribution[4];
  const lifecycle = contribution[5];
  if (
    !viewSource ||
    !viewArgument ||
    !decorate ||
    !param ||
    !commandService ||
    !registerContribution ||
    !lifecycle
  ) {
    return { status: "unsupported", detail: "Workbench anchors are incomplete" };
  }

  const annotatedView = viewSource.replace(
    `this.id=${viewArgument}.id,`,
    `this.id=${viewArgument}.id,this.element.dataset.codexBridgeViewId=this.id,`,
  );
  if (annotatedView === viewSource) {
    return { status: "unsupported", detail: "ViewPane identity patch did not apply" };
  }
  const withViewIdentity =
    source.slice(0, view.index) +
    annotatedView +
    source.slice((view.index ?? 0) + viewSource.length);
  const exportIndex = withViewIdentity.indexOf(mainExport[0]);
  if (exportIndex < 0) {
    return { status: "unsupported", detail: "Workbench main export moved during patching" };
  }
  const patch = injectedContribution({
    commandService,
    decorate,
    lifecycle,
    param,
    registerContribution,
  });
  return {
    status: "patchable",
    patchedSource:
      withViewIdentity.slice(0, exportIndex) + patch + withViewIdentity.slice(exportIndex),
  };
}
