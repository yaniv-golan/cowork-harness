/**
 * `analyze-artifact-runtime` — Tier B, the OPTIONAL runtime jsdom confirmer for the Cowork
 * interactive-artifact write-back bug class (see
 * `docs/internal/2026-07-15-harness-improvements-from-skillcreator-plan.md`, Item 1 §B1/§B4, and its
 * working prototype `docs/internal/artifact-roundtrip-prototypes/rt_detect.mjs`, which this module
 * adapts). Tier A (`analyze-artifact.ts`, static AST) is the always-on default; this module CONFIRMS a
 * Tier A suspicion (or independently flags dynamic construction / guard-falseness Tier A can't see) by
 * actually driving a materialized `.html` artifact under a headless DOM. It is a fast-follow confirmer,
 * never the primary signal, and (per §B4) does not gate on its own.
 *
 * THREAT MODEL (§B1(b) — READ BEFORE CALLING): this module executes the artifact's own `<script>`
 * content with `runScripts: "dangerously"` in the SAME Node process as the caller, with NO process/VM
 * isolation. That is acceptable ONLY under a TRUSTED-SOURCE scope — an author confirming their own
 * skill's own generated artifact. It is NOT a security boundary and MUST NOT be pointed at an
 * adversarial third-party skill's artifact; doing so would need a real isolation tier (`microvm`), which
 * this module does not provide. `SECURITY.md` documents the harness sandbox as a fidelity fixture, not a
 * security boundary, for the same reason.
 *
 * HARDENING WITHIN THAT SCOPE (defends against a buggy — not malicious — page crashing the host
 * process, not against a hostile one):
 *   - every phase that runs page script (JSDOM construction, the fill/click/submit loop) is wrapped in
 *     try/catch; a synchronous throw becomes an `inconclusive` verdict, never a rethrow;
 *   - `process.on("uncaughtException"/"unhandledRejection", ...)` listeners are installed for the
 *     duration of each single run and removed in a `finally`, so an asynchronous throw from a timer or
 *     an unattached promise chain (jsdom does not always let these surface as a synchronous exception
 *     out of the constructor call) is also captured instead of crashing the process;
 *   - `resources: undefined` — jsdom does not fetch external stylesheets/scripts/images, so nothing this
 *     module does ever performs real network I/O;
 *   - `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, `HTMLFormElement.prototype.submit`/
 *     `requestSubmit`, `URL.createObjectURL`, and anchor `.click()` are all stubbed to RECORD, never
 *     PERFORM — no request the artifact issues, relative or remote, ever leaves the process. A
 *     synchronous infinite loop in page script cannot be preempted from within the same thread (no
 *     Worker/subprocess boundary here); that residual risk is exactly why this module is scoped to
 *     trusted sources rather than claimed as a sandbox.
 *
 * DEPENDENCY RULE: `jsdom` is a devDependency ONLY (see `package.json`) — this module MUST NOT statically
 * import it. `confirmArtifactRuntime` performs `await import("jsdom")` dynamically, inside a try/catch;
 * if jsdom is not installed in the consumer's environment (Tier B is optional), it returns
 * `{ available: false, reason }` — it never throws and never hard-requires the package.
 *
 * VERDICT CONTRACT — three runs of the "human": every `<input>/<textarea>/<select>` is filled, then
 * every clickable and every `<form>` is clicked/submitted (two passes, to catch controls a first-pass
 * handler creates), run TWICE against a stubbed Cowork-like origin — once where the stub answers every
 * fetch/XHR "200 OK", once "404 Not Found" — mirroring the real Cowork behavior where a relative
 * write-back resolves but the origin never actually implements the artifact's private API. `lost` fires
 * when a commit action's local write-back is followed by a blob-download fallback, an unread response,
 * or a final DOM identical across both runs (the page cannot tell success from failure — a false
 * "Saved!"). `suspect` fires when a local write-back's page correctly distinguishes the two runs (still
 * broken under Cowork, just not silently so). `clean` = no local write-back fired (a remote absolute
 * `https://` write-back is a different bug class entirely and is explicitly ignored here). `inconclusive`
 * = the artifact could not be meaningfully driven at all (page script threw, its behavior depends on an
 * external CDN/framework bundle jsdom never loaded, or it has no interactive controls to click).
 */

// ------------------------------------------------------------------------------------------------- //
// Minimal ambient typing for the optional `jsdom` devDependency.
// ------------------------------------------------------------------------------------------------- //
// jsdom ships no bundled `.d.ts`, and this repo intentionally does not add `@types/jsdom` (jsdom itself
// must stay a devDependency, never a runtime one — see the module header). Both a string-literal
// `import("jsdom")` (static OR dynamic) and a `declare module "jsdom" { ... }` augmentation fail to
// compile here — TS insists on resolving the literal specifier to jsdom's own (typeless) files and then
// refuses to layer a declaration on top of what it resolved (TS2665/TS7016). `loadJsdom()` below routes
// the specifier through a non-literal (a local `const`), which is opaque to TS's specifier-based module
// resolution, so the import expression itself types as `unknown` instead of erroring — then a single
// cast into the hand-written interfaces below restores real typechecking for everything downstream.
// `window` is typed `any` throughout this module: without `@types/jsdom`/the DOM lib there is no
// browser-global type to lean on, and this module dynamically patches arbitrary properties onto it
// anyway.

interface JsdomVirtualConsole {
  on(event: string, listener: (...args: unknown[]) => void): this;
}
interface JsdomOptions {
  url?: string;
  runScripts?: "dangerously" | "outside-only";
  pretendToBeVisual?: boolean;
  virtualConsole?: JsdomVirtualConsole;
  resources?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see module header re: `window: any`
  beforeParse?: (window: any) => void;
}
interface JsdomInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see module header re: `window: any`
  readonly window: any;
}
interface JsdomModule {
  JSDOM: new (html: string, options?: JsdomOptions) => JsdomInstance;
  VirtualConsole: new () => JsdomVirtualConsole;
}

// ------------------------------------------------------------------------------------------------- //
// Public contract
// ------------------------------------------------------------------------------------------------- //

export type RuntimeVerdictLabel = "lost" | "suspect" | "clean" | "inconclusive";
export type RuntimeConfidence = "high" | "low";

export type RuntimeVerdict =
  | { available: false; reason: string }
  | { available: true; verdict: RuntimeVerdictLabel; confidence: RuntimeConfidence; evidence: string[] };

const JSDOM_UNAVAILABLE_REASON = "jsdom not installed — run `npm i jsdom` to enable runtime confirmation";

/** The public entry point. `htmlPath` is used only for attribution in diagnostic evidence text (the
 *  content actually analyzed is always `html` — the caller is responsible for materializing whatever
 *  on-disk/generated source produced it). Never throws. */
export async function confirmArtifactRuntime(htmlPath: string, html: string): Promise<RuntimeVerdict> {
  return confirmArtifactRuntimeWithLoader(htmlPath, html, loadJsdom);
}

/** Same contract as `confirmArtifactRuntime`, with the jsdom loader injected — exported so the
 *  jsdom-unavailable guard path is directly testable without needing to actually uninstall jsdom from a
 *  dev environment that has it. `confirmArtifactRuntime` above always calls this with `loadJsdom`. */
export async function confirmArtifactRuntimeWithLoader(
  htmlPath: string,
  html: string,
  loader: () => Promise<JsdomModule>,
): Promise<RuntimeVerdict> {
  let jsdomModule: JsdomModule;
  try {
    jsdomModule = await loader();
  } catch {
    return { available: false, reason: JSDOM_UNAVAILABLE_REASON };
  }

  try {
    const okRun = await runOnce(jsdomModule, html, "ok");
    const failRun = await runOnce(jsdomModule, html, "fail");
    const { verdict, confidence, evidence } = computeVerdict(okRun, failRun);
    return { available: true, verdict, confidence, evidence };
  } catch (e) {
    // Belt-and-suspenders: runOnce() itself never throws (every phase is internally hardened — see the
    // module header), but a defensive outer catch means a genuinely unexpected failure still surfaces as
    // `inconclusive` evidence rather than propagating out of a "never throws" contract.
    return {
      available: true,
      verdict: "inconclusive",
      confidence: "low",
      evidence: [`runtime confirmer crashed while analyzing ${htmlPath}: ${errMessage(e)}`],
    };
  }
}

async function loadJsdom(): Promise<JsdomModule> {
  // Non-literal specifier — see the ambient-typing note above for why. If jsdom truly is not installed,
  // this rejects (`ERR_MODULE_NOT_FOUND`) exactly like a literal `import("jsdom")` would; the caller's
  // try/catch is what turns that into the graceful `{ available: false }` result.
  const specifier: string = "jsdom";
  const mod: unknown = await import(specifier);
  return mod as JsdomModule;
}

// ------------------------------------------------------------------------------------------------- //
// Internal types
// ------------------------------------------------------------------------------------------------- //

type ActionType = "edit" | "commit";
interface ActionCtx {
  id: number;
  type: ActionType;
  label: string;
}

/** Where a write-back URL resolves relative to the simulated Cowork origin. `relative`/`localhost`/
 *  `same-origin-absolute` are all "this bug class" (isLocalTarget below); `remote` is a genuinely
 *  different origin and is explicitly out of scope (see the plan: "a remote absolute https:// write-back
 *  is NOT this bug class — ignore it"). */
type UrlTarget = "relative" | "localhost" | "same-origin-absolute" | "remote" | "unparseable";

interface RequestRecord {
  kind: "fetch" | "xhr" | "beacon" | "form";
  url: string;
  method: string;
  hasBody: boolean;
  target: UrlTarget;
  action: ActionCtx | null;
  okAccessed: boolean;
  statusAccessed: boolean;
  bodyConsulted: boolean;
}

interface DownloadRecord {
  href: string;
  download: string | null;
  action: ActionCtx | null;
}

interface RunLog {
  requests: RequestRecord[];
  downloads: DownloadRecord[];
  errors: string[];
  crashed: boolean;
  finalDOM: string;
  externalScripts: string[];
  inlineScriptHasContent: boolean;
  controlsCount: number;
}

// ------------------------------------------------------------------------------------------------- //
// Constants + small helpers
// ------------------------------------------------------------------------------------------------- //

// An https origin shaped like Cowork's real artifact viewer, per the plan ("load the emitted artifact
// HTML in jsdom at an https Cowork-like origin"). `.invalid` is the RFC 2606 reserved TLD for exactly
// this purpose — guaranteed non-resolvable, and never dereferenced anyway (network is fully stubbed).
const PAGE_URL = "https://artifacts.cowork.invalid/v1/view/artifact/index.html";

// Kept short — these are minimal single-purpose fixture pages (no real debounce timers to wait out), and
// the whole point of §B4 is that this stays a fast confirmer, not a slow one. `LOAD_SETTLE_MS` is the
// longest: constructing the JSDOM can execute page script asynchronously relative to the constructor call
// returning (see the module header's hardening note), so this is also the window in which a delayed
// uncaughtException gets captured before the interaction loop starts.
const LOAD_SETTLE_MS = 60;
const ACTION_SETTLE_MS = 25;
const FINAL_SETTLE_MS = 60;

const realSetTimeout = setTimeout;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function isWrite(r: RequestRecord): boolean {
  return WRITE_METHODS.has(r.method) || r.kind === "beacon";
}
function isLocalTarget(t: UrlTarget): boolean {
  return t === "relative" || t === "localhost" || t === "same-origin-absolute";
}

// ------------------------------------------------------------------------------------------------- //
// Network/DOM stubs — record, never perform
// ------------------------------------------------------------------------------------------------- //

interface StubHooks {
  mode: "ok" | "fail";
  pageUrl: string;
  ctxBox: { current: ActionCtx | null };
  requests: RequestRecord[];
  downloads: DownloadRecord[];
  errors: string[];
  crashedBox: { current: boolean };
}

/** Patches the jsdom `window` (called from `beforeParse`, before any page script runs) so every
 *  write-back primitive RECORDS its call instead of performing it, and the recorded call carries the
 *  ACTION CONTEXT (`ctxBox.current`) it fired under — propagated through `setTimeout` callbacks and
 *  through `.then/.catch/.finally` chains rooted at the stubbed `fetch`, so an async write-back issued
 *  from inside a debounce timer or a promise chain is still attributed to the user action that triggered
 *  it (best-effort; if attribution is lost the DOM-equality and unread-response signals still apply). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- window has no usable static type here
function installStubs(window: any, hooks: StubHooks): void {
  const { mode, pageUrl, ctxBox, requests, downloads, errors, crashedBox } = hooks;
  const origSetTimeout = window.setTimeout.bind(window);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapCb = (fn: any) => {
    const ctx = ctxBox.current;
    return function (this: unknown, ...a: unknown[]) {
      const prev = ctxBox.current;
      ctxBox.current = ctx;
      try {
        return typeof fn === "function" ? fn.apply(this, a) : undefined;
      } finally {
        ctxBox.current = prev;
      }
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  window.setTimeout = (fn: any, d?: number, ...a: unknown[]) => origSetTimeout(wrapCb(fn), Math.min(d || 0, 25), ...a);

  const classify = (url: string): UrlTarget => {
    try {
      const u = new window.URL(url, pageUrl);
      if (/^(localhost|127\.|0\.0\.0\.0)/.test(u.hostname)) return "localhost";
      if (u.origin === new window.URL(pageUrl).origin) {
        // Written as an absolute same-origin URL, or as a bare relative path?
        return /^[a-z]+:\/\//i.test(String(url)) ? "same-origin-absolute" : "relative";
      }
      return "remote";
    } catch {
      return "unparseable";
    }
  };

  const record = (kind: RequestRecord["kind"], url: string, method: string | undefined, hasBody: boolean): RequestRecord => {
    const rec: RequestRecord = {
      kind,
      url: String(url),
      method: (method || "GET").toUpperCase(),
      hasBody: !!hasBody,
      target: classify(String(url)),
      action: ctxBox.current ? { ...ctxBox.current } : null,
      okAccessed: false,
      statusAccessed: false,
      bodyConsulted: false,
    };
    requests.push(rec);
    return rec;
  };

  const failBody = "<!doctype html><html><body><h1>404 Not Found</h1></body></html>";
  const okBody = "{}";
  const makeResponse = (rec: RequestRecord) => ({
    get ok() {
      rec.okAccessed = true;
      return mode === "ok";
    },
    get status() {
      rec.statusAccessed = true;
      return mode === "ok" ? 200 : 404;
    },
    get statusText() {
      return mode === "ok" ? "OK" : "Not Found";
    },
    headers: { get: (h: string) => (/content-type/i.test(h) ? (mode === "ok" ? "application/json" : "text/html") : null) },
    json() {
      rec.bodyConsulted = true;
      return mode === "ok" ? Promise.resolve({}) : Promise.reject(new SyntaxError("Unexpected token '<'"));
    },
    text() {
      rec.bodyConsulted = true;
      return Promise.resolve(mode === "ok" ? okBody : failBody);
    },
  });

  // Action-context propagation through promise chains rooted at the stubbed fetch, so a download fired
  // from a `.catch()` fallback (or a `.then()` success branch) is still attributed to the user action
  // whose write-back it followed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bindCtx = (fn: any, ctx: ActionCtx | null) =>
    fn &&
    function (this: unknown, ...a: unknown[]) {
      const prev = ctxBox.current;
      ctxBox.current = ctx;
      try {
        return wrapIfPromise(fn.apply(this, a), ctx);
      } finally {
        ctxBox.current = prev;
      }
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapIfPromise = (v: any, ctx: ActionCtx | null) => (v && typeof v.then === "function" ? wrapPromise(v, ctx) : v);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapPromise = (p: Promise<unknown>, ctx: ActionCtx | null): any => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then(onF: any, onR: any) {
      return wrapPromise(p.then(bindCtx(onF, ctx), bindCtx(onR, ctx)), ctx);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    catch(onR: any) {
      return this.then(undefined, onR);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    finally(onF: any) {
      return wrapPromise(p.finally(bindCtx(onF, ctx)), ctx);
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  window.fetch = (url: string, opts: any = {}) => {
    const rec = record("fetch", url, opts.method, opts.body != null);
    return wrapPromise(Promise.resolve(makeResponse(rec)), ctxBox.current ? { ...ctxBox.current } : null);
  };

  window.XMLHttpRequest = class FakeXHR {
    _rec: RequestRecord | undefined;
    readyState = 0;
    status = 0;
    responseText = "";
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    _l: Record<string, () => void> | undefined;
    open(m: string, u: string) {
      this._rec = record("xhr", u, m, false);
      this.readyState = 1;
    }
    setRequestHeader() {
      /* no-op stub */
    }
    addEventListener(t: string, fn: () => void) {
      (this._l ??= {})[t] = fn;
    }
    send(body: unknown) {
      if (body != null && this._rec) this._rec.hasBody = true;
      const rec = this._rec;
      origSetTimeout(
        wrapCb(() => {
          this.readyState = 4;
          const st = mode === "ok" ? 200 : 404;
          this.responseText = mode === "ok" ? okBody : failBody;
          Object.defineProperty(this, "status", {
            get() {
              if (rec) rec.statusAccessed = true;
              return st;
            },
            configurable: true,
          });
          this.onreadystatechange?.();
          this.onload?.();
          this._l?.load?.call(this);
        }),
        5,
      );
    }
  };

  window.navigator.sendBeacon = (url: string, data: unknown) => {
    record("beacon", url, "POST", data != null);
    return true;
  };

  window.URL.createObjectURL = () => `blob:${pageUrl}/fake-${Math.random().toString(36).slice(2)}`;
  window.URL.revokeObjectURL = () => {
    /* no-op stub */
  };

  const origClick = window.HTMLElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function (this: {
    href?: string;
    hasAttribute: (n: string) => boolean;
    getAttribute: (n: string) => string | null;
  }) {
    const href = this.href || "";
    if (this.hasAttribute("download") || href.startsWith("blob:") || href.startsWith("data:")) {
      downloads.push({
        href: href.slice(0, 60),
        download: this.getAttribute("download"),
        action: ctxBox.current ? { ...ctxBox.current } : null,
      });
      return;
    }
    return origClick.call(this);
  };

  window.HTMLFormElement.prototype.submit = function (this: { getAttribute: (n: string) => string | null; method?: string }) {
    record("form", this.getAttribute("action") || window.location.href, this.method || "GET", true);
  };
  window.HTMLFormElement.prototype.requestSubmit = function (this: { getAttribute: (n: string) => string | null; method?: string }) {
    record("form", this.getAttribute("action") || window.location.href, this.method || "GET", true);
  };

  // jsdom dispatches this exactly like a real browser's `window.onerror` for an uncaught synchronous
  // page-script exception — a targeted, low-false-positive crash signal (unlike the broader
  // `virtualConsole` "jsdomError" channel, which also carries benign notices such as unimplemented
  // navigation/CSS features that must NOT flip this artifact to `inconclusive`).
  window.addEventListener("error", (e: { message?: string }) => {
    errors.push(String(e.message).slice(0, 200));
    crashedBox.current = true;
  });
}

// ------------------------------------------------------------------------------------------------- //
// One full "play the human" pass
// ------------------------------------------------------------------------------------------------- //

async function runOnce(jsdomModule: JsdomModule, html: string, mode: "ok" | "fail"): Promise<RunLog> {
  const log: RunLog = {
    requests: [],
    downloads: [],
    errors: [],
    crashed: false,
    finalDOM: "",
    externalScripts: [],
    inlineScriptHasContent: false,
    controlsCount: 0,
  };
  const ctxBox: { current: ActionCtx | null } = { current: null };
  const crashedBox: { current: boolean } = { current: false };
  let actionSeq = 0;

  // See the module header's hardening note: an async page-script throw (a timer callback, an unattached
  // promise chain) does not always surface as a synchronous exception out of the JSDOM constructor call —
  // catch it at the process level too, scoped strictly to this single run via add-then-remove.
  const crashes: string[] = [];
  const onUncaught = (e: unknown) => crashes.push(errMessage(e).slice(0, 200));
  const onRejection = (reason: unknown) => crashes.push(`unhandled rejection: ${errMessage(reason).slice(0, 200)}`);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dom: any;
  try {
    const vc = new jsdomModule.VirtualConsole();
    vc.on("jsdomError", (e: unknown) => log.errors.push(errMessage(e).slice(0, 200)));
    vc.on("error", (...a: unknown[]) => log.errors.push(a.map(String).join(" ").slice(0, 200)));

    dom = new jsdomModule.JSDOM(html, {
      url: PAGE_URL,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: vc,
      // No external resource loading (stylesheets/scripts/images/frames): nothing this module does can
      // ever perform real network I/O, and a page whose behavior lives entirely in an unloaded external
      // bundle correctly comes out `inconclusive` rather than falsely `clean` (see computeVerdict).
      resources: undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      beforeParse(window: any) {
        installStubs(window, {
          mode,
          pageUrl: PAGE_URL,
          ctxBox,
          requests: log.requests,
          downloads: log.downloads,
          errors: log.errors,
          crashedBox,
        });
      },
    });
  } catch (e) {
    log.crashed = true;
    log.errors.push(`jsdom construction threw: ${errMessage(e)}`);
  }

  if (dom) {
    try {
      const { window } = dom;
      const document = window.document;
      await sleep(LOAD_SETTLE_MS); // let load-time scripts + load-time fetches settle

      log.externalScripts = [...document.querySelectorAll("script[src]")].map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => s.getAttribute("src") || "",
      );
      log.inlineScriptHasContent = [...document.querySelectorAll("script:not([src])")].some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => (s.textContent || "").trim().length > 0,
      );

      const controls = [
        ...document.querySelectorAll(
          'input, textarea, select, button, [role="button"], input[type="submit"], input[type="button"], [onclick], form',
        ),
      ];
      log.controlsCount = controls.length;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dispatch = (el: any, type: string, ctor: any = window.Event) => {
        el.dispatchEvent(new ctor(type, { bubbles: true, cancelable: true }));
      };

      const withAction = async (type: ActionType, label: string, fn: () => void) => {
        ctxBox.current = { id: ++actionSeq, type, label: String(label).slice(0, 40) };
        try {
          fn();
        } catch (e) {
          log.errors.push(`action(${label}): ${errMessage(e).slice(0, 120)}`);
        }
        ctxBox.current = null;
        await sleep(ACTION_SETTLE_MS); // microtasks + accelerated debounce timers
      };

      // Phase 1: EDIT actions — populate every field, dispatch input/change.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const el of [...document.querySelectorAll("input, textarea, select")] as any[]) {
        await withAction("edit", el.id || el.name || el.tagName, () => {
          if (el.tagName === "SELECT") {
            if (el.options && el.options.length) el.selectedIndex = el.options.length - 1;
          } else if (el.type === "checkbox" || el.type === "radio") {
            el.checked = !el.checked;
          } else {
            el.value = el.type === "number" ? "42" : "runtime probe";
          }
          dispatch(el, "input");
          dispatch(el, "change");
        });
      }
      await sleep(ACTION_SETTLE_MS);

      // Phase 2: COMMIT actions — click every clickable, submit every form. Two passes: the second
      // catches controls a first-pass handler creates dynamically.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clicked = new Set<any>();
      for (let pass = 0; pass < 2; pass++) {
        const clickables = [
          ...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], [onclick]'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any[];
        for (const el of clickables) {
          if (clicked.has(el)) continue;
          clicked.add(el);
          const label = (el.textContent || el.value || el.id || "").trim().slice(0, 40);
          await withAction("commit", `click:${label}`, () => dispatch(el, "click", window.MouseEvent));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const form of [...document.querySelectorAll("form")] as any[]) {
          if (clicked.has(form)) continue;
          clicked.add(form);
          await withAction("commit", "submit-form", () => {
            const ev = new window.Event("submit", { bubbles: true, cancelable: true });
            form.dispatchEvent(ev);
            if (!ev.defaultPrevented) form.submit();
          });
        }
      }
      await sleep(FINAL_SETTLE_MS); // flush trailing debounces/handlers

      log.finalDOM = document.body ? document.body.innerHTML.replace(/\s+/g, " ").trim() : "";
    } catch (e) {
      log.crashed = true;
      log.errors.push(`interaction loop threw: ${errMessage(e)}`);
    } finally {
      try {
        dom.window.close();
      } catch {
        // best effort — a crashed page may leave the window in a state close() itself throws on
      }
    }
  }

  process.off("uncaughtException", onUncaught);
  process.off("unhandledRejection", onRejection);

  if (crashes.length > 0) {
    log.crashed = true;
    log.errors.push(...crashes);
  }
  if (crashedBox.current) {
    log.crashed = true;
  }

  return log;
}

// ------------------------------------------------------------------------------------------------- //
// Verdict
// ------------------------------------------------------------------------------------------------- //

function computeVerdict(
  okRun: RunLog,
  failRun: RunLog,
): { verdict: RuntimeVerdictLabel; confidence: RuntimeConfidence; evidence: string[] } {
  const evidence: string[] = [];

  if (okRun.crashed || failRun.crashed) {
    const msg = failRun.errors[0] || okRun.errors[0] || "unknown script error";
    evidence.push(`page script threw during execution (${msg}) — artifact not reliably runnable under jsdom; fall back to static analysis`);
    return { verdict: "inconclusive", confidence: "low", evidence };
  }

  // The page's real behavior lives entirely in an external <script src> bundle jsdom never fetched (no
  // external resource loading — see runOnce). Whatever controls exist in the raw markup were never
  // wired by that bundle, so this could not be meaningfully driven at all.
  const needsExternalFramework = failRun.externalScripts.length > 0 && !failRun.inlineScriptHasContent && !okRun.inlineScriptHasContent;
  if (needsExternalFramework) {
    evidence.push(
      `page depends on external script(s) (${failRun.externalScripts.join(", ")}) with no inline logic — jsdom does not fetch external resources, so the page's real behavior could not be exercised`,
    );
    return { verdict: "inconclusive", confidence: "low", evidence };
  }

  if (failRun.controlsCount === 0) {
    evidence.push("no interactive controls (input/button/form) found in the artifact — nothing to drive");
    return { verdict: "inconclusive", confidence: "low", evidence };
  }

  const writebacks = failRun.requests.filter((r) => isWrite(r) && isLocalTarget(r.target) && r.action?.type === "commit");
  const remoteWritebacks = failRun.requests.filter((r) => isWrite(r) && r.target === "remote" && r.action?.type === "commit");

  if (writebacks.length === 0) {
    if (remoteWritebacks.length > 0) {
      evidence.push(
        `only remote absolute write-back(s) observed (${remoteWritebacks.map((r) => `${r.method} ${r.url}`).join(", ")}) — resolves against a real external origin, not this bug class`,
      );
    } else {
      evidence.push("no relative/local write-back fired from any user action");
    }
    // A CLEAN verdict on a page that references external scripts, made zero requests of any kind, and
    // logged errors may just mean the page could not fully wire its handlers under jsdom — flag lower
    // confidence rather than claim certainty it is genuinely bug-free.
    const suspiciouslyQuiet = failRun.externalScripts.length > 0 && failRun.requests.length === 0 && failRun.errors.length > 0;
    return { verdict: "clean", confidence: suspiciouslyQuiet ? "low" : "high", evidence };
  }

  const domEqual = okRun.finalDOM === failRun.finalDOM && failRun.finalDOM.length > 0;
  const wbActionIds = new Set(writebacks.map((w) => w.action!.id));
  const dlAfterFail = failRun.downloads.filter((d) => d.action && wbActionIds.has(d.action.id));
  const unread = writebacks.filter((w) => !w.okAccessed && !w.statusAccessed && !w.bodyConsulted);

  evidence.push(
    `${writebacks.length} relative/local write-back(s) fired on a user commit action (${writebacks
      .map((w) => `${w.method} ${w.url} on "${w.action!.label}"`)
      .join("; ")})`,
  );

  const lostReasons: string[] = [];
  if (dlAfterFail.length > 0) {
    lostReasons.push(
      `blob/download fallback fired after the non-ok write-back (${dlAfterFail.map((d) => d.href).join(", ")}) — broken under Cowork's embedded artifact viewer`,
    );
  }
  if (domEqual) {
    lostReasons.push(
      'final DOM after a simulated server FAILURE (404) is identical to the final DOM after a simulated server SUCCESS (200) — the page cannot distinguish failure from success (false "Saved!")',
    );
  }
  if (unread.length > 0) {
    lostReasons.push(
      `response never consulted for ${unread.length} write-back(s) (ok/status/body unread: ${unread
        .map((w) => `${w.method} ${w.url}`)
        .join(", ")}) — unconditional success path`,
    );
  }

  if (lostReasons.length > 0) {
    evidence.push(...lostReasons);
    return { verdict: "lost", confidence: "high", evidence };
  }

  evidence.push(
    "the page correctly distinguished the simulated failure (response consulted, final DOM differs from the success run, no blind download fallback) — but the write-back still targets Cowork's own origin and will never actually persist the data",
  );
  return { verdict: "suspect", confidence: "high", evidence };
}
