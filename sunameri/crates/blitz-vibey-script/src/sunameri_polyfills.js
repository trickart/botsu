// sunameri 拡張: X(Twitter)などの SPA が必要とする Web API のポリフィル群。
//
// 方針:
// - 既に blitz-vibey-script が提供しているものは上書きしない(`in` で確認する)。
// - 本物の挙動が必要なもの(Event の構築と dispatchEvent、history、Storage、
//   Observer、matchMedia)は JS で実装する。
// - 実装できないもの(canvas、Worker など)は「無い」ことが分かる形(undefined)か、
//   安全な no-op にする。
(function () {
    "use strict";

    const config = () => globalThis.__sunameri_config || {};
    const define = (obj, name, value, opts = {}) => {
        Object.defineProperty(obj, name, { value, writable: true, configurable: true, enumerable: false, ...opts });
    };
    const defineIfMissing = (obj, name, value) => { if (!(name in obj)) define(obj, name, value); };
    const accessor = (obj, name, get, set) => {
        Object.defineProperty(obj, name, { get, set, configurable: true, enumerable: false });
    };
    const accessorIfMissing = (obj, name, get, set) => { if (!(name in obj)) accessor(obj, name, get, set); };

    const nodeProto = Node.prototype;
    const elementProto = Element.prototype;
    const documentProto = Document.prototype;
    const charDataProto = Object.getPrototypeOf(document.createTextNode(""));
    const fragmentProto = Object.getPrototypeOf(document.createDocumentFragment());

    // =========================================================================
    // Event: 構築可能な Event と、JS からの dispatchEvent
    // =========================================================================
    const nativeEventProto = typeof __blitz_event_proto === "function" ? __blitz_event_proto() : null;

    function Event(type, init = {}) {
        if (!new.target) throw new TypeError("Failed to construct 'Event': Please use the 'new' operator.");
        if (arguments.length === 0) throw new TypeError("Failed to construct 'Event': 1 argument required, but only 0 present.");
        const flags = { prevented: false, stopped: false, stoppedImmediate: false, phase: 0 };
        const defs = {
            type: { value: String(type), enumerable: true, configurable: true },
            bubbles: { value: !!init.bubbles, enumerable: true, configurable: true },
            cancelable: { value: !!init.cancelable, enumerable: true, configurable: true },
            composed: { value: !!init.composed, enumerable: true, configurable: true },
            target: { value: null, enumerable: true, configurable: true, writable: true },
            currentTarget: { value: null, enumerable: true, configurable: true, writable: true },
            srcElement: { value: null, enumerable: true, configurable: true, writable: true },
            isTrusted: { value: false, enumerable: true, configurable: true },
            timeStamp: { value: performance.now(), enumerable: true, configurable: true },
            returnValue: { get: () => !flags.prevented, set: (v) => { if (!v && this.cancelable) flags.prevented = true; }, configurable: true },
            cancelBubble: { get: () => flags.stopped, set: (v) => { if (v) flags.stopped = true; }, configurable: true },
            defaultPrevented: { get: () => flags.prevented, configurable: true },
            eventPhase: { get: () => flags.phase, configurable: true },
            _flags: { value: flags, configurable: true },
            preventDefault: { value: function () { if (this.cancelable) flags.prevented = true; }, configurable: true, writable: true },
            stopPropagation: { value: function () { flags.stopped = true; }, configurable: true, writable: true },
            stopImmediatePropagation: { value: function () { flags.stopped = true; flags.stoppedImmediate = true; }, configurable: true, writable: true },
            composedPath: { value: function () { return this._path ? this._path.slice() : (this.target ? [this.target] : []); }, configurable: true, writable: true },
            initEvent: { value: function (t, bubbles = false, cancelable = false) {
                Object.defineProperty(this, "type", { value: String(t), enumerable: true, configurable: true });
                Object.defineProperty(this, "bubbles", { value: !!bubbles, enumerable: true, configurable: true });
                Object.defineProperty(this, "cancelable", { value: !!cancelable, enumerable: true, configurable: true });
            }, configurable: true, writable: true },
        };
        Object.defineProperties(this, defs);
    }
    Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;
    if (nativeEventProto) {
        Event.prototype = nativeEventProto;
        define(nativeEventProto, "constructor", Event);
        // ネイティブイベントに無いメソッド/プロパティの既定値
        defineIfMissing(nativeEventProto, "composedPath", function () { return this.target ? [this.target] : []; });
        defineIfMissing(nativeEventProto, "initEvent", function () {});
        for (const [k, v] of [["NONE", 0], ["CAPTURING_PHASE", 1], ["AT_TARGET", 2], ["BUBBLING_PHASE", 3]]) defineIfMissing(nativeEventProto, k, v);
        if (!("cancelBubble" in nativeEventProto)) accessor(nativeEventProto, "cancelBubble", function () { return false; }, function (v) { if (v) this.stopPropagation(); });
        if (!("returnValue" in nativeEventProto)) accessor(nativeEventProto, "returnValue", function () { return !this.defaultPrevented; }, function (v) { if (!v) this.preventDefault(); });
    }
    globalThis.Event = Event;

    const makeEventClass = (name, fields, parent = Event) => {
        const cls = class extends parent {
            constructor(type, init = {}) {
                super(type, init);
                for (const [field, def] of fields) {
                    Object.defineProperty(this, field, { value: init[field] !== undefined ? init[field] : (typeof def === "function" ? def(init) : def), enumerable: true, configurable: true, writable: true });
                }
            }
        };
        Object.defineProperty(cls, "name", { value: name });
        globalThis[name] = cls;
        return cls;
    };
    const CustomEvent = makeEventClass("CustomEvent", [["detail", null]]);
    define(CustomEvent.prototype, "initCustomEvent", function (type, bubbles, cancelable, detail) { this.initEvent(type, bubbles, cancelable); Object.defineProperty(this, "detail", { value: detail, configurable: true, writable: true }); });
    const UIEvent = makeEventClass("UIEvent", [["view", null], ["detail", 0], ["which", 0]]);
    const MouseEvent = makeEventClass("MouseEvent", [["screenX", 0], ["screenY", 0], ["clientX", 0], ["clientY", 0], ["pageX", (i) => i.clientX ?? 0], ["pageY", (i) => i.clientY ?? 0], ["offsetX", 0], ["offsetY", 0], ["x", (i) => i.clientX ?? 0], ["y", (i) => i.clientY ?? 0], ["ctrlKey", false], ["shiftKey", false], ["altKey", false], ["metaKey", false], ["button", 0], ["buttons", 0], ["relatedTarget", null], ["movementX", 0], ["movementY", 0]], UIEvent);
    define(MouseEvent.prototype, "getModifierState", function (k) { return !!this[{ Control: "ctrlKey", Shift: "shiftKey", Alt: "altKey", Meta: "metaKey" }[k]]; });
    define(MouseEvent.prototype, "initMouseEvent", function (type, bubbles, cancelable) { this.initEvent(type, bubbles, cancelable); });
    makeEventClass("PointerEvent", [["pointerId", 0], ["width", 1], ["height", 1], ["pressure", 0], ["tangentialPressure", 0], ["tiltX", 0], ["tiltY", 0], ["twist", 0], ["pointerType", ""], ["isPrimary", false]], MouseEvent);
    makeEventClass("WheelEvent", [["deltaX", 0], ["deltaY", 0], ["deltaZ", 0], ["deltaMode", 0]], MouseEvent);
    makeEventClass("DragEvent", [["dataTransfer", null]], MouseEvent);
    const KeyboardEvent = makeEventClass("KeyboardEvent", [["key", ""], ["code", ""], ["location", 0], ["ctrlKey", false], ["shiftKey", false], ["altKey", false], ["metaKey", false], ["repeat", false], ["isComposing", false], ["charCode", 0], ["keyCode", 0]], UIEvent);
    define(KeyboardEvent.prototype, "getModifierState", MouseEvent.prototype.getModifierState);
    KeyboardEvent.DOM_KEY_LOCATION_STANDARD = 0; KeyboardEvent.DOM_KEY_LOCATION_LEFT = 1; KeyboardEvent.DOM_KEY_LOCATION_RIGHT = 2; KeyboardEvent.DOM_KEY_LOCATION_NUMPAD = 3;
    makeEventClass("FocusEvent", [["relatedTarget", null]], UIEvent);
    makeEventClass("InputEvent", [["data", null], ["isComposing", false], ["inputType", ""], ["dataTransfer", null]], UIEvent);
    makeEventClass("CompositionEvent", [["data", ""]], UIEvent);
    makeEventClass("TouchEvent", [["touches", []], ["targetTouches", []], ["changedTouches", []], ["ctrlKey", false], ["shiftKey", false], ["altKey", false], ["metaKey", false]], UIEvent);
    makeEventClass("PopStateEvent", [["state", null], ["hasUAVisualTransition", false]]);
    makeEventClass("HashChangeEvent", [["oldURL", ""], ["newURL", ""]]);
    makeEventClass("PageTransitionEvent", [["persisted", false]]);
    makeEventClass("BeforeUnloadEvent", []);
    makeEventClass("ErrorEvent", [["message", ""], ["filename", ""], ["lineno", 0], ["colno", 0], ["error", null]]);
    makeEventClass("PromiseRejectionEvent", [["promise", null], ["reason", undefined]]);
    makeEventClass("MessageEvent", [["data", null], ["origin", ""], ["lastEventId", ""], ["source", null], ["ports", []]]);
    makeEventClass("StorageEvent", [["key", null], ["oldValue", null], ["newValue", null], ["url", ""], ["storageArea", null]]);
    makeEventClass("ProgressEvent", [["lengthComputable", false], ["loaded", 0], ["total", 0]]);
    makeEventClass("TransitionEvent", [["propertyName", ""], ["elapsedTime", 0], ["pseudoElement", ""]]);
    makeEventClass("AnimationEvent", [["animationName", ""], ["elapsedTime", 0], ["pseudoElement", ""]]);
    makeEventClass("ClipboardEvent", [["clipboardData", null]]);
    makeEventClass("SubmitEvent", [["submitter", null]]);
    makeEventClass("FormDataEvent", [["formData", null]]);
    makeEventClass("ToggleEvent", [["oldState", ""], ["newState", ""]]);
    makeEventClass("SecurityPolicyViolationEvent", []);

    // ---- EventTarget(DOM ノード以外で使う汎用実装)------------------------------
    const listenerKey = Symbol("listeners");
    class EventTarget {
        constructor() { Object.defineProperty(this, listenerKey, { value: new Map(), configurable: true }); }
        addEventListener(type, cb, options) {
            if (!cb) return;
            const capture = typeof options === "object" && options !== null ? !!options.capture : !!options;
            const once = typeof options === "object" && options !== null ? !!options.once : false;
            const list = this[listenerKey].get(String(type)) ?? [];
            if (list.some((l) => l.cb === cb && l.capture === capture)) return;
            list.push({ cb, capture, once });
            this[listenerKey].set(String(type), list);
        }
        removeEventListener(type, cb, options) {
            const capture = typeof options === "object" && options !== null ? !!options.capture : !!options;
            const list = this[listenerKey].get(String(type));
            if (list) this[listenerKey].set(String(type), list.filter((l) => !(l.cb === cb && l.capture === capture)));
        }
        dispatchEvent(event) {
            if (!event || typeof event.type !== "string") throw new TypeError("parameter 1 is not of type 'Event'.");
            setEventProp(event, "target", this);
            setEventProp(event, "currentTarget", this);
            invokeListeners(this, event, (this[listenerKey].get(event.type) ?? []).map((l) => [l.cb, l.capture, l.once]));
            setEventProp(event, "currentTarget", null);
            return !event.defaultPrevented;
        }
    }
    globalThis.EventTarget = EventTarget;

    const setEventProp = (event, name, value) => {
        try { Object.defineProperty(event, name, { value, configurable: true, writable: true, enumerable: true }); } catch (e) {}
    };
    const reportUncaught = (e) => {
        try {
            const head = e instanceof Error ? e.name + ": " + e.message : String(e);
            console.error("Uncaught " + head + (e && e.stack ? "\n" + e.stack : ""));
        } catch (_) {}
    };
    // listeners: [[callback, capture, once], ...]
    const invokeListeners = (target, event, listeners, phase = "target") => {
        const onHandler = target && target["on" + event.type];
        const all = listeners.filter(([, capture]) => phase === "target" || (phase === "capture") === capture);
        if (phase !== "capture" && typeof onHandler === "function") all.unshift([onHandler, false, false]);
        for (const [cb, capture, once] of all) {
            if (once) {
                if (target[listenerKey]) target.removeEventListener(event.type, cb, capture);
                else if (typeof target.removeEventListener === "function") target.removeEventListener(event.type, cb, capture);
            }
            try {
                if (typeof cb === "function") cb.call(target, event);
                else if (cb && typeof cb.handleEvent === "function") cb.handleEvent(event);
            } catch (e) { reportUncaught(e); }
            if (event._flags ? event._flags.stoppedImmediate : false) return true;
        }
        return false;
    };
    const nodeListeners = (target, type) => (typeof __blitz_get_listeners === "function" ? __blitz_get_listeners(target, type) : []);
    const isStopped = (event) => (event._flags ? event._flags.stopped : false);

    /** DOM ノードまたは window を対象にイベントを送出する(capture → target → bubble) */
    const dispatchOnNode = function (event) {
        if (!event || typeof event.type !== "string") throw new TypeError("parameter 1 is not of type 'Event'.");
        const target = this;
        const path = [];
        let n = target;
        while (n) { path.push(n); n = n === globalThis ? null : n.parentNode; }
        if (target !== globalThis && path[path.length - 1] === document) path.push(globalThis);
        else if (target !== globalThis && !path.includes(globalThis) && target.isConnected) path.push(globalThis);
        setEventProp(event, "target", target);
        setEventProp(event, "srcElement", target);
        try { Object.defineProperty(event, "_path", { value: path, configurable: true }); } catch (e) {}
        const flags = event._flags;
        // capture
        for (let i = path.length - 1; i > 0; i--) {
            if (flags) flags.phase = 1;
            setEventProp(event, "currentTarget", path[i]);
            if (invokeListeners(path[i], event, nodeListeners(path[i], event.type), "capture") || isStopped(event)) break;
        }
        if (!isStopped(event)) {
            if (flags) flags.phase = 2;
            setEventProp(event, "currentTarget", target);
            invokeListeners(target, event, nodeListeners(target, event.type), "target");
        }
        if (event.bubbles && !isStopped(event)) {
            for (let i = 1; i < path.length; i++) {
                if (flags) flags.phase = 3;
                setEventProp(event, "currentTarget", path[i]);
                if (invokeListeners(path[i], event, nodeListeners(path[i], event.type), "bubble") || isStopped(event)) break;
            }
        }
        if (flags) flags.phase = 0;
        setEventProp(event, "currentTarget", null);
        return !event.defaultPrevented;
    };
    defineIfMissing(nodeProto, "dispatchEvent", dispatchOnNode);
    defineIfMissing(globalThis, "dispatchEvent", dispatchOnNode);

    // =========================================================================
    // performance
    // =========================================================================
    if (typeof globalThis.performance === "undefined") {
        const timeOrigin = Date.now();
        const entries = [];
        const perf = {
            timeOrigin,
            now() { return Date.now() - timeOrigin; },
            mark(name, opts) { const e = { name, entryType: "mark", startTime: opts?.startTime ?? this.now(), duration: 0, detail: opts?.detail ?? null, toJSON() { return { ...this }; } }; entries.push(e); return e; },
            measure(name, start, end) {
                let s = 0, d = 0;
                if (typeof start === "object" && start !== null) { s = start.start ?? 0; d = (start.end ?? this.now()) - s; }
                else { const sm = typeof start === "string" ? entries.find((e) => e.name === start) : null; const em = typeof end === "string" ? entries.find((e) => e.name === end) : null; s = sm ? sm.startTime : 0; d = (em ? em.startTime : this.now()) - s; }
                const e = { name, entryType: "measure", startTime: s, duration: d, toJSON() { return { ...this }; } };
                entries.push(e); return e;
            },
            clearMarks(name) { for (let i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === "mark" && (name === undefined || entries[i].name === name)) entries.splice(i, 1); },
            clearMeasures(name) { for (let i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === "measure" && (name === undefined || entries[i].name === name)) entries.splice(i, 1); },
            clearResourceTimings() {},
            setResourceTimingBufferSize() {},
            getEntries() { return entries.slice(); },
            getEntriesByType(t) { return entries.filter((e) => e.entryType === t); },
            getEntriesByName(n, t) { return entries.filter((e) => e.name === n && (t === undefined || e.entryType === t)); },
            navigation: { type: 0, redirectCount: 0, TYPE_NAVIGATE: 0, TYPE_RELOAD: 1, TYPE_BACK_FORWARD: 2, toJSON() { return { type: 0, redirectCount: 0 }; } },
            timing: { navigationStart: timeOrigin, fetchStart: timeOrigin, domainLookupStart: timeOrigin, domainLookupEnd: timeOrigin, connectStart: timeOrigin, connectEnd: timeOrigin, requestStart: timeOrigin, responseStart: timeOrigin, responseEnd: timeOrigin, domLoading: timeOrigin, domInteractive: timeOrigin, domContentLoadedEventStart: timeOrigin, domContentLoadedEventEnd: timeOrigin, domComplete: timeOrigin, loadEventStart: timeOrigin, loadEventEnd: timeOrigin, unloadEventStart: 0, unloadEventEnd: 0, redirectStart: 0, redirectEnd: 0, secureConnectionStart: 0, toJSON() { return { ...this }; } },
            eventCounts: new Map(),
            addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
            toJSON() { return { timeOrigin }; },
        };
        globalThis.performance = perf;
        globalThis.Performance = function Performance() { throw new TypeError("Illegal constructor"); };
        Performance.prototype = Object.getPrototypeOf(perf);
    }
    if (typeof globalThis.PerformanceObserver === "undefined") {
        class PerformanceObserver {
            static supportedEntryTypes = ["mark", "measure"];
            constructor(cb) { this._cb = cb; }
            observe() {}
            disconnect() {}
            takeRecords() { return []; }
        }
        globalThis.PerformanceObserver = PerformanceObserver;
        globalThis.PerformanceEntry = function PerformanceEntry() { throw new TypeError("Illegal constructor"); };
        globalThis.PerformanceMark = globalThis.PerformanceEntry;
        globalThis.PerformanceMeasure = globalThis.PerformanceEntry;
    }

    // =========================================================================
    // タイマー系の補助
    // =========================================================================
    defineIfMissing(globalThis, "requestIdleCallback", function (cb, opts) {
        const timeout = opts && opts.timeout ? Math.min(opts.timeout, 50) : 1;
        return setTimeout(() => { const start = performance.now(); cb({ didTimeout: false, timeRemaining: () => Math.max(0, 50 - (performance.now() - start)) }); }, timeout);
    });
    defineIfMissing(globalThis, "cancelIdleCallback", function (id) { clearTimeout(id); });
    defineIfMissing(globalThis, "setImmediate", function (cb, ...args) { return setTimeout(cb, 0, ...args); });
    defineIfMissing(globalThis, "clearImmediate", function (id) { clearTimeout(id); });
    if (typeof globalThis.MessageChannel === "undefined") {
        class MessagePort extends EventTarget {
            constructor() { super(); this._other = null; this.onmessage = null; this._started = false; this._queue = []; }
            postMessage(data) {
                const other = this._other;
                if (!other) return;
                setTimeout(() => { other._deliver(data); }, 0);
            }
            _deliver(data) {
                const ev = new MessageEvent("message", { data });
                this.dispatchEvent(ev);
            }
            start() { this._started = true; }
            close() { this._other = null; }
        }
        class MessageChannel {
            constructor() {
                this.port1 = new MessagePort();
                this.port2 = new MessagePort();
                this.port1._other = this.port2;
                this.port2._other = this.port1;
            }
        }
        globalThis.MessageChannel = MessageChannel;
        globalThis.MessagePort = MessagePort;
    }
    if (typeof globalThis.BroadcastChannel === "undefined") {
        const channels = new Map();
        class BroadcastChannel extends EventTarget {
            constructor(name) { super(); this.name = String(name); this.onmessage = null; (channels.get(this.name) ?? channels.set(this.name, new Set()).get(this.name)).add(this); }
            postMessage(data) { for (const c of channels.get(this.name) ?? []) if (c !== this) setTimeout(() => c.dispatchEvent(new MessageEvent("message", { data })), 0); }
            close() { channels.get(this.name)?.delete(this); }
        }
        globalThis.BroadcastChannel = BroadcastChannel;
    }

    // =========================================================================
    // Storage(メモリ上。永続化は後で埋め込み側フックを足す)
    // =========================================================================
    if (typeof globalThis.localStorage === "undefined") {
        const makeStorage = () => {
            const map = new Map();
            const storage = {
                get length() { return map.size; },
                key(i) { return [...map.keys()][i] ?? null; },
                getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
                setItem(k, v) { map.set(String(k), String(v)); },
                removeItem(k) { map.delete(String(k)); },
                clear() { map.clear(); },
            };
            return new Proxy(storage, {
                get(t, p) { if (p in t || typeof p === "symbol") return t[p]; return map.has(p) ? map.get(p) : undefined; },
                set(t, p, v) { if (p in t) return false; map.set(String(p), String(v)); return true; },
                deleteProperty(t, p) { map.delete(String(p)); return true; },
                has(t, p) { return p in t || map.has(p); },
                ownKeys(t) { return [...map.keys()]; },
                getOwnPropertyDescriptor(t, p) { return map.has(p) ? { value: map.get(p), writable: true, enumerable: true, configurable: true } : undefined; },
            });
        };
        globalThis.localStorage = makeStorage();
        globalThis.sessionStorage = makeStorage();
        globalThis.Storage = function Storage() { throw new TypeError("Illegal constructor"); };
    }

    // =========================================================================
    // crypto
    // =========================================================================
    if (typeof globalThis.crypto === "undefined") {
        const randomBytes = (n) => (typeof __blitz_random_bytes === "function" ? __blitz_random_bytes(n) : Array.from({ length: n }, () => Math.floor(Math.random() * 256)));
        const crypto = {
            getRandomValues(array) {
                if (!ArrayBuffer.isView(array)) throw new TypeError("Argument 1 is not a typed array");
                const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
                const rnd = randomBytes(bytes.byteLength);
                for (let i = 0; i < bytes.byteLength; i++) bytes[i] = rnd[i];
                return array;
            },
            randomUUID() {
                const b = randomBytes(16);
                b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
                const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
                return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
            },
            subtle: undefined,
        };
        if (typeof __blitz_digest === "function") {
            const toBytes = (data) => {
                if (data instanceof ArrayBuffer) return Array.from(new Uint8Array(data));
                if (ArrayBuffer.isView(data)) return Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                return Array.from(new TextEncoder().encode(String(data)));
            };
            const algoName = (a) => String(typeof a === "string" ? a : (a && a.name) || "").toUpperCase();
            const toBuffer = (arr) => new Uint8Array(arr).buffer;
            const notSupported = (what) => Promise.reject(new DOMException(what + " is not supported", "NotSupportedError"));
            class CryptoKey { constructor(algorithm, raw, usages, extractable) { this.type = "secret"; this.algorithm = algorithm; this.usages = usages; this.extractable = extractable; Object.defineProperty(this, "_raw", { value: raw }); } }
            crypto.subtle = {
                digest(algorithm, data) {
                    try { return Promise.resolve(toBuffer(__blitz_digest(algoName(algorithm), toBytes(data)))); } catch (e) { return Promise.reject(e); }
                },
                importKey(format, keyData, algorithm, extractable, usages) {
                    if (format !== "raw") return notSupported("importKey format " + format);
                    const algo = typeof algorithm === "string" ? { name: algorithm } : algorithm;
                    return Promise.resolve(new CryptoKey(algo, toBytes(keyData), usages, !!extractable));
                },
                exportKey(format, key) { return format === "raw" && key._raw ? Promise.resolve(toBuffer(key._raw)) : notSupported("exportKey"); },
                sign(algorithm, key, data) {
                    const name = algoName(algorithm);
                    if (name !== "HMAC" || !key || !key._raw) return notSupported("sign " + name);
                    const hash = algoName(key.algorithm && key.algorithm.hash);
                    try { return Promise.resolve(toBuffer(__blitz_hmac(hash || "SHA-256", key._raw, toBytes(data)))); } catch (e) { return Promise.reject(e); }
                },
                verify(algorithm, key, signature, data) {
                    return this.sign(algorithm, key, data).then((sig) => { const a = new Uint8Array(sig), b = new Uint8Array(toBytes(signature)); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; });
                },
                generateKey() { return notSupported("generateKey"); },
                encrypt() { return notSupported("encrypt"); },
                decrypt() { return notSupported("decrypt"); },
                deriveBits() { return notSupported("deriveBits"); },
                deriveKey() { return notSupported("deriveKey"); },
                wrapKey() { return notSupported("wrapKey"); },
                unwrapKey() { return notSupported("unwrapKey"); },
            };
            globalThis.CryptoKey = CryptoKey;
            globalThis.SubtleCrypto = function SubtleCrypto() { throw new TypeError("Illegal constructor"); };
        }
        globalThis.crypto = crypto;
        globalThis.Crypto = function Crypto() { throw new TypeError("Illegal constructor"); };
    }

    // =========================================================================
    // matchMedia
    // =========================================================================
    if (typeof globalThis.matchMedia === "undefined") {
        const evalFeature = (name, value) => {
            const px = (v) => parseFloat(v);
            switch (name) {
                case "min-width": return innerWidth >= px(value);
                case "max-width": return innerWidth <= px(value);
                case "width": return innerWidth === px(value);
                case "min-height": return innerHeight >= px(value);
                case "max-height": return innerHeight <= px(value);
                case "height": return innerHeight === px(value);
                case "orientation": return value === (innerWidth >= innerHeight ? "landscape" : "portrait");
                case "prefers-color-scheme": return value === (config().colorScheme ?? "light");
                case "prefers-reduced-motion": return value === "no-preference";
                case "prefers-reduced-transparency": return value === "no-preference";
                case "prefers-contrast": return value === "no-preference";
                case "forced-colors": return value === "none";
                case "hover": return value === "hover";
                case "any-hover": return value === "hover";
                case "pointer": return value === "fine";
                case "any-pointer": return value === "fine";
                case "display-mode": return value === "browser";
                case "min-resolution": return px(value) <= devicePixelRatio * (value.endsWith("dpi") ? 96 : 1);
                case "max-resolution": return px(value) >= devicePixelRatio * (value.endsWith("dpi") ? 96 : 1);
                case "resolution": return true;
                case "-webkit-min-device-pixel-ratio": return devicePixelRatio >= px(value);
                case "-webkit-max-device-pixel-ratio": return devicePixelRatio <= px(value);
                case "min-aspect-ratio": case "max-aspect-ratio": case "aspect-ratio": return true;
                case "color": return true;
                case "scripting": return value === "enabled";
                case "update": return value === "fast";
                case "inverted-colors": return value === "none";
                case "dynamic-range": return value === "standard";
                default: return false;
            }
        };
        const evalQuery = (q) => {
            q = q.trim().toLowerCase();
            if (!q) return true;
            // "a, b" は OR
            if (q.includes(",")) return q.split(",").some(evalQuery);
            let not = false;
            if (q.startsWith("not ")) { not = true; q = q.slice(4); }
            if (q.startsWith("only ")) q = q.slice(5);
            const parts = q.split(/\s+and\s+/);
            let result = true;
            for (let part of parts) {
                part = part.trim();
                if (part === "all" || part === "screen") continue;
                if (part === "print" || part === "speech") { result = false; continue; }
                const m = part.match(/^\(\s*([a-z-]+)\s*(?::\s*(.+?))?\s*\)$/);
                if (!m) {
                    const range = part.match(/^\(\s*(?:(\d+(?:\.\d+)?)(px)?\s*(<=|<)\s*)?(width|height)\s*(?:(<=|<)\s*(\d+(?:\.\d+)?)(px)?)?\s*\)$/);
                    if (range) {
                        const dim = range[4] === "width" ? innerWidth : innerHeight;
                        let ok = true;
                        if (range[1] !== undefined) ok = ok && (range[3] === "<=" ? parseFloat(range[1]) <= dim : parseFloat(range[1]) < dim);
                        if (range[6] !== undefined) ok = ok && (range[5] === "<=" ? dim <= parseFloat(range[6]) : dim < parseFloat(range[6]));
                        result = result && ok;
                        continue;
                    }
                    result = false; continue;
                }
                const [, name, value] = m;
                if (value === undefined) { result = result && (name === "hover" || name === "pointer" || name === "color" || name === "any-hover" || name === "any-pointer"); continue; }
                result = result && evalFeature(name, value.trim());
            }
            return not ? !result : result;
        };
        class MediaQueryList extends EventTarget {
            constructor(media) { super(); this._media = media; this.onchange = null; }
            get media() { return this._media; }
            get matches() { return evalQuery(this._media); }
            addListener(cb) { this.addEventListener("change", cb); }
            removeListener(cb) { this.removeEventListener("change", cb); }
        }
        const lists = new Set();
        globalThis.matchMedia = function matchMedia(query) { const l = new MediaQueryList(String(query)); lists.add(l); l._last = l.matches; return l; };
        globalThis.MediaQueryList = MediaQueryList;
        globalThis.MediaQueryListEvent = makeEventClass("MediaQueryListEvent", [["matches", false], ["media", ""]]);
        addEventListener("resize", () => {
            for (const l of lists) {
                const now = l.matches;
                if (now !== l._last) { l._last = now; l.dispatchEvent(new MediaQueryListEvent("change", { matches: now, media: l.media })); }
            }
        });
    }

    // =========================================================================
    // Observer 群
    // =========================================================================
    if (typeof globalThis.MutationObserver === "undefined") {
        // 変更通知は(まだ)無い。observe/disconnect は受け付ける。
        class MutationObserver {
            constructor(cb) { this._cb = cb; this._targets = []; }
            observe(target, options) { this._targets.push([target, options]); }
            disconnect() { this._targets = []; }
            takeRecords() { return []; }
        }
        globalThis.MutationObserver = MutationObserver;
        globalThis.MutationRecord = function MutationRecord() { throw new TypeError("Illegal constructor"); };
    }

    if (typeof globalThis.IntersectionObserver === "undefined") {
        const POLL_MS = 250;
        const observers = new Set();
        let timer = null;
        const parseMargin = (s) => {
            const parts = String(s || "0px").trim().split(/\s+/).map((p) => ({ value: parseFloat(p) || 0, percent: p.endsWith("%") }));
            while (parts.length < 4) parts.push(parts[parts.length === 1 ? 0 : parts.length === 2 ? 0 : 1]);
            return parts;
        };
        const rootRect = (observer) => {
            if (observer.root && typeof observer.root.getBoundingClientRect === "function") return observer.root.getBoundingClientRect();
            return { top: 0, left: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight, x: 0, y: 0 };
        };
        const compute = (observer, target) => {
            const r = target.getBoundingClientRect();
            const root = rootRect(observer);
            const m = observer._margin;
            const top = root.top - (m[0].percent ? root.height * m[0].value / 100 : m[0].value);
            const right = root.right + (m[1].percent ? root.width * m[1].value / 100 : m[1].value);
            const bottom = root.bottom + (m[2].percent ? root.height * m[2].value / 100 : m[2].value);
            const left = root.left - (m[3].percent ? root.width * m[3].value / 100 : m[3].value);
            const ix = Math.max(0, Math.min(r.right, right) - Math.max(r.left, left));
            const iy = Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top));
            const area = r.width * r.height;
            const ratio = area > 0 ? (ix * iy) / area : (ix > 0 || iy > 0 || (r.left >= left && r.left <= right && r.top >= top && r.top <= bottom) ? 1 : 0);
            const isIntersecting = target.isConnected && (ratio > 0 || (area === 0 && r.left <= right && r.right >= left && r.top <= bottom && r.bottom >= top));
            return { boundingClientRect: r, rootBounds: { top, left, right, bottom, width: right - left, height: bottom - top, x: left, y: top }, intersectionRect: { x: 0, y: 0, top: 0, left: 0, width: ix, height: iy, right: ix, bottom: iy }, intersectionRatio: isIntersecting ? Math.max(ratio, Number.EPSILON) : 0, isIntersecting, target, time: performance.now(), isVisible: isIntersecting };
        };
        const thresholdIndex = (observer, ratio, isIntersecting) => { if (!isIntersecting) return -1; let i = 0; for (const t of observer.thresholds) { if (ratio >= t) i++; } return i; };
        const tick = () => {
            for (const observer of observers) {
                const records = [];
                for (const [target, state] of observer._targets) {
                    const entry = compute(observer, target);
                    const idx = thresholdIndex(observer, entry.intersectionRatio, entry.isIntersecting);
                    if (state.idx !== idx) { state.idx = idx; records.push(entry); }
                }
                if (records.length) { try { observer._cb(records, observer); } catch (e) { reportUncaught(e); } }
            }
            timer = observers.size ? setTimeout(tick, POLL_MS) : null;
        };
        class IntersectionObserver {
            constructor(cb, options = {}) {
                this._cb = cb;
                this.root = options.root ?? null;
                this.rootMargin = String(options.rootMargin ?? "0px 0px 0px 0px");
                this._margin = parseMargin(this.rootMargin);
                const t = options.threshold ?? 0;
                this.thresholds = (Array.isArray(t) ? t : [t]).map(Number).sort((a, b) => a - b);
                if (!this.thresholds.length) this.thresholds = [0];
                this._targets = new Map();
            }
            observe(target) {
                if (!target || this._targets.has(target)) return;
                this._targets.set(target, { idx: -2 });
                observers.add(this);
                if (!timer) timer = setTimeout(tick, 0);
            }
            unobserve(target) { this._targets.delete(target); if (!this._targets.size) observers.delete(this); }
            disconnect() { this._targets.clear(); observers.delete(this); }
            takeRecords() { return []; }
        }
        globalThis.IntersectionObserver = IntersectionObserver;
        globalThis.IntersectionObserverEntry = function IntersectionObserverEntry() { throw new TypeError("Illegal constructor"); };
    }

    if (typeof globalThis.ResizeObserver === "undefined") {
        const POLL_MS = 300;
        const observers = new Set();
        let timer = null;
        const entryFor = (target) => {
            const r = target.getBoundingClientRect();
            const size = [{ inlineSize: r.width, blockSize: r.height }];
            return { target, contentRect: { x: 0, y: 0, top: 0, left: 0, width: r.width, height: r.height, right: r.width, bottom: r.height }, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size };
        };
        const tick = () => {
            for (const observer of observers) {
                const records = [];
                for (const [target, state] of observer._targets) {
                    const r = target.getBoundingClientRect();
                    if (state.w !== r.width || state.h !== r.height) { state.w = r.width; state.h = r.height; records.push(entryFor(target)); }
                }
                if (records.length) { try { observer._cb(records, observer); } catch (e) { reportUncaught(e); } }
            }
            timer = observers.size ? setTimeout(tick, POLL_MS) : null;
        };
        class ResizeObserver {
            constructor(cb) { this._cb = cb; this._targets = new Map(); }
            observe(target) {
                if (!target || this._targets.has(target)) return;
                this._targets.set(target, { w: -1, h: -1 });
                observers.add(this);
                if (!timer) timer = setTimeout(tick, 0);
            }
            unobserve(target) { this._targets.delete(target); if (!this._targets.size) observers.delete(this); }
            disconnect() { this._targets.clear(); observers.delete(this); }
        }
        globalThis.ResizeObserver = ResizeObserver;
        globalThis.ResizeObserverEntry = function ResizeObserverEntry() { throw new TypeError("Illegal constructor"); };
    }

    // =========================================================================
    // history(セッション履歴つき) / location
    // =========================================================================
    {
        const entries = [{ state: null, url: location.href, title: "" }];
        let index = 0;
        // location.href を「読むと現在の URL、代入するとナビゲーション」にする。
        // 内部からの無音更新(pushState)は applyUrl を使う。
        let currentHref = location.href;
        Object.defineProperty(location, "href", {
            configurable: true, enumerable: true,
            get() { return currentHref; },
            set(v) { navigate(String(v), false); },
        });
        const applyUrl = (href) => {
            try {
                const u = new URL(href, currentHref);
                currentHref = u.href;
                location.protocol = u.protocol; location.host = u.host; location.hostname = u.hostname;
                location.port = u.port; location.pathname = u.pathname; location.search = u.search; location.hash = u.hash; location.origin = u.origin;
            } catch (e) {}
        };
        globalThis.__sunameri_apply_url = applyUrl;
        const history = {
            get length() { return entries.length; },
            scrollRestoration: "auto",
            get state() { return entries[index].state; },
            pushState(state, title, url) {
                entries.splice(index + 1);
                entries.push({ state: state === undefined ? null : structuredCloneSafe(state), url: url == null ? location.href : new URL(String(url), location.href).href, title: String(title ?? "") });
                index = entries.length - 1;
                applyUrl(entries[index].url);
            },
            replaceState(state, title, url) {
                entries[index] = { state: state === undefined ? null : structuredCloneSafe(state), url: url == null ? location.href : new URL(String(url), location.href).href, title: String(title ?? "") };
                applyUrl(entries[index].url);
            },
            go(delta = 0) {
                delta = Number(delta) || 0;
                if (delta === 0) { setTimeout(() => location.reload(), 0); return; }
                const next = index + delta;
                if (next < 0 || next >= entries.length) return;
                setTimeout(() => {
                    const oldHash = location.hash, oldHref = location.href;
                    index = next;
                    applyUrl(entries[index].url);
                    globalThis.dispatchEvent(new PopStateEvent("popstate", { state: entries[index].state }));
                    if (oldHash !== location.hash) globalThis.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: oldHref, newURL: location.href }));
                }, 0);
            },
            back() { this.go(-1); },
            forward() { this.go(1); },
        };
        const structuredCloneSafe = (v) => { try { return structuredClone(v); } catch (e) { return v; } };
        define(globalThis, "history", history, { enumerable: true });
        globalThis.History = function History() { throw new TypeError("Illegal constructor"); };

        const navigate = (url, replace, method = "GET", body = null, contentType = null) => {
            let resolved;
            try { resolved = new URL(String(url), currentHref); } catch (e) { throw new DOMException("Invalid URL: " + url, "SyntaxError"); }
            // 同一文書内のフラグメント移動はナビゲーションしない
            if (method === "GET" && resolved.hash && resolved.href.split("#")[0] === currentHref.split("#")[0] && !replace) {
                const old = currentHref;
                applyUrl(resolved.href);
                setTimeout(() => globalThis.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: old, newURL: currentHref })), 0);
                return;
            }
            if (typeof __blitz_navigate === "function") { __blitz_navigate(resolved.href, method, body, contentType, !!replace); return; }
            console.warn("navigation is not available: " + resolved.href);
        };
        globalThis.__sunameri_navigate = navigate;
        defineIfMissing(location, "assign", (url) => navigate(url, false));
        defineIfMissing(location, "replace", (url) => navigate(url, true));
        defineIfMissing(location, "reload", () => { if (typeof __blitz_navigate === "function") __blitz_navigate(currentHref, "GET", null, null, true); });
        defineIfMissing(location, "toString", () => currentHref);
        defineIfMissing(location, "valueOf", () => location);
        defineIfMissing(location, "port", "");
        defineIfMissing(location, "ancestorOrigins", []);
        globalThis.Location = function Location() { throw new TypeError("Illegal constructor"); };
    }

    // =========================================================================
    // navigator / screen / window の雑多なプロパティ
    // =========================================================================
    {
        const nav = navigator;
        const ua = () => config().userAgent ?? "Mozilla/5.0 (X11; Linux armv7l; rv:128.0) Gecko/20100101 Firefox/128.0";
        accessor(nav, "userAgent", ua);
        accessor(nav, "appVersion", () => ua().replace(/^Mozilla\//, ""));
        defineIfMissing(nav, "appName", "Netscape");
        defineIfMissing(nav, "appCodeName", "Mozilla");
        defineIfMissing(nav, "product", "Gecko");
        defineIfMissing(nav, "productSub", "20100101");
        defineIfMissing(nav, "vendor", "");
        defineIfMissing(nav, "vendorSub", "");
        accessorIfMissing(nav, "language", () => config().language ?? "ja");
        accessorIfMissing(nav, "languages", () => config().languages ?? ["ja", "en-US", "en"]);
        accessorIfMissing(nav, "platform", () => config().platform ?? "Linux armv7l");
        defineIfMissing(nav, "oscpu", "Linux armv7l");
        defineIfMissing(nav, "onLine", true);
        defineIfMissing(nav, "cookieEnabled", true);
        defineIfMissing(nav, "doNotTrack", null);
        defineIfMissing(nav, "globalPrivacyControl", false);
        defineIfMissing(nav, "hardwareConcurrency", 1);
        defineIfMissing(nav, "deviceMemory", 0.5);
        defineIfMissing(nav, "maxTouchPoints", config().maxTouchPoints ?? 0);
        defineIfMissing(nav, "webdriver", false);
        defineIfMissing(nav, "pdfViewerEnabled", false);
        defineIfMissing(nav, "javaEnabled", () => false);
        defineIfMissing(nav, "vibrate", () => false);
        defineIfMissing(nav, "sendBeacon", (url, data) => { try { fetch(url, { method: "POST", body: data ?? null, keepalive: true }).catch(() => {}); return true; } catch (e) { return false; } });
        defineIfMissing(nav, "clipboard", { writeText: (t) => { globalThis.__sunameri_clipboard = String(t); return Promise.resolve(); }, readText: () => Promise.resolve(globalThis.__sunameri_clipboard ?? ""), write: () => Promise.resolve(), read: () => Promise.reject(new DOMException("not supported", "NotAllowedError")), addEventListener() {}, removeEventListener() {} });
        defineIfMissing(nav, "permissions", { query: () => Promise.resolve({ state: "denied", onchange: null, addEventListener() {}, removeEventListener() {} }) });
        defineIfMissing(nav, "storage", { estimate: () => Promise.resolve({ quota: 0, usage: 0 }), persist: () => Promise.resolve(false), persisted: () => Promise.resolve(false) });
        defineIfMissing(nav, "geolocation", { getCurrentPosition: (ok, err) => { if (err) setTimeout(() => err({ code: 1, message: "denied", PERMISSION_DENIED: 1 }), 0); }, watchPosition: () => 0, clearWatch() {} });
        defineIfMissing(nav, "plugins", Object.assign([], { item: () => null, namedItem: () => null, refresh() {} }));
        defineIfMissing(nav, "mimeTypes", Object.assign([], { item: () => null, namedItem: () => null }));
        defineIfMissing(nav, "share", () => Promise.reject(new DOMException("not supported", "NotAllowedError")));
        defineIfMissing(nav, "canShare", () => false);
        defineIfMissing(nav, "registerProtocolHandler", () => {});
        defineIfMissing(nav, "getBattery", () => Promise.resolve({ charging: true, level: 1, chargingTime: 0, dischargingTime: Infinity, addEventListener() {}, removeEventListener() {} }));
        globalThis.Navigator = function Navigator() { throw new TypeError("Illegal constructor"); };
        Navigator.prototype = Object.getPrototypeOf(nav);

        if (typeof globalThis.screen === "undefined") {
            const screen = {
                get width() { return innerWidth; }, get height() { return innerHeight; },
                get availWidth() { return innerWidth; }, get availHeight() { return innerHeight; },
                availLeft: 0, availTop: 0, colorDepth: 24, pixelDepth: 24, isExtended: false,
                orientation: { get type() { return innerWidth >= innerHeight ? "landscape-primary" : "portrait-primary"; }, angle: 0, onchange: null, lock: () => Promise.reject(new DOMException("not supported", "NotSupportedError")), unlock() {}, addEventListener() {}, removeEventListener() {} },
                addEventListener() {}, removeEventListener() {},
            };
            define(globalThis, "screen", screen, { enumerable: true });
            globalThis.Screen = function Screen() { throw new TypeError("Illegal constructor"); };
        }

        const w = globalThis;
        defineIfMissing(w, "name", "");
        accessorIfMissing(w, "origin", () => location.origin);
        accessorIfMissing(w, "isSecureContext", () => location.protocol === "https:" || location.protocol === "file:");
        defineIfMissing(w, "crossOriginIsolated", false);
        accessorIfMissing(w, "frames", () => w);
        defineIfMissing(w, "length", 0);
        defineIfMissing(w, "frameElement", null);
        defineIfMissing(w, "status", "");
        defineIfMissing(w, "closed", false);
        defineIfMissing(w, "screenX", 0); defineIfMissing(w, "screenY", 0); defineIfMissing(w, "screenLeft", 0); defineIfMissing(w, "screenTop", 0);
        for (const bar of ["locationbar", "menubar", "personalbar", "scrollbars", "statusbar", "toolbar"]) defineIfMissing(w, bar, { visible: true });
        for (const h of ["onerror", "onunhandledrejection", "onrejectionhandled", "onpopstate", "onhashchange", "onresize", "onscroll", "onload", "onbeforeunload", "onunload", "onpagehide", "onpageshow", "onfocus", "onblur", "onmessage", "onmessageerror", "onstorage", "ononline", "onoffline", "onvisibilitychange", "onlanguagechange", "onorientationchange"]) {
            if (!(h in w)) { let v = null; accessor(w, h, () => v, (nv) => { v = typeof nv === "function" ? nv : null; }); }
        }
        defineIfMissing(w, "postMessage", function (data, targetOrigin) {
            setTimeout(() => { w.dispatchEvent(new MessageEvent("message", { data: (() => { try { return structuredClone(data); } catch (e) { return data; } })(), origin: location.origin, source: w })); }, 0);
        });
        defineIfMissing(w, "alert", (m) => { console.log("[alert] " + m); });
        defineIfMissing(w, "confirm", (m) => { console.log("[confirm] " + m); return false; });
        defineIfMissing(w, "prompt", (m) => { console.log("[prompt] " + m); return null; });
        defineIfMissing(w, "print", () => {});
        defineIfMissing(w, "open", (url) => { console.log("[window.open] " + url); return null; });
        defineIfMissing(w, "close", () => {});
        defineIfMissing(w, "stop", () => {});
        defineIfMissing(w, "focus", () => {});
        defineIfMissing(w, "blur", () => {});
        defineIfMissing(w, "moveTo", () => {}); defineIfMissing(w, "moveBy", () => {}); defineIfMissing(w, "resizeTo", () => {}); defineIfMissing(w, "resizeBy", () => {});
        defineIfMissing(w, "reportError", (e) => { reportUncaught(e); w.dispatchEvent(new ErrorEvent("error", { message: String(e && e.message || e), error: e })); });
        defineIfMissing(w, "getSelection", () => null);
        if (typeof w.visualViewport === "undefined") {
            const vv = new EventTarget();
            Object.defineProperties(vv, {
                width: { get: () => innerWidth }, height: { get: () => innerHeight }, offsetLeft: { value: 0 }, offsetTop: { value: 0 },
                pageLeft: { get: () => scrollX }, pageTop: { get: () => scrollY }, scale: { value: 1 }, onresize: { value: null, writable: true }, onscroll: { value: null, writable: true },
            });
            define(w, "visualViewport", vv);
        }
        defineIfMissing(w, "scheduler", { postTask: (cb, opts) => new Promise((res, rej) => setTimeout(() => { try { res(cb()); } catch (e) { rej(e); } }, opts && opts.delay || 0)), yield: () => new Promise((r) => setTimeout(r, 0)) });
        if (typeof w.customElements === "undefined") {
            const registry = new Map();
            const waiting = new Map();
            define(w, "customElements", {
                define(name, ctor) { registry.set(name, ctor); waiting.get(name)?.forEach((r) => r(ctor)); waiting.delete(name); },
                get: (name) => registry.get(name),
                getName: (ctor) => { for (const [n, c] of registry) if (c === ctor) return n; return null; },
                whenDefined: (name) => registry.has(name) ? Promise.resolve(registry.get(name)) : new Promise((r) => (waiting.get(name) ?? waiting.set(name, []).get(name)).push(r)),
                upgrade() {},
            });
            w.CustomElementRegistry = function CustomElementRegistry() { throw new TypeError("Illegal constructor"); };
        }
        defineIfMissing(w, "Image", function Image(width, height) { const img = document.createElement("img"); if (width !== undefined) img.setAttribute("width", String(width)); if (height !== undefined) img.setAttribute("height", String(height)); return img; });
        w.Image.prototype = elementProto;
        defineIfMissing(w, "Audio", function Audio(src) { const a = document.createElement("audio"); if (src !== undefined) a.setAttribute("src", String(src)); return a; });
        w.Audio.prototype = elementProto;
        defineIfMissing(w, "Option", function Option(text, value, defaultSelected, selected) { const o = document.createElement("option"); if (text !== undefined) o.textContent = String(text); if (value !== undefined) o.setAttribute("value", String(value)); if (defaultSelected) o.setAttribute("selected", ""); return o; });
        w.Option.prototype = elementProto;
        defineIfMissing(Error, "captureStackTrace", () => {});
        defineIfMissing(Error, "stackTraceLimit", 10);
    }

    // =========================================================================
    // document
    // =========================================================================
    {
        const d = documentProto;
        // document.title の setter(react-helmet などが代入する)。<title> が無ければ head に作る
        {
            const desc = Object.getOwnPropertyDescriptor(d, "title");
            if (desc && desc.get && !desc.set) {
                Object.defineProperty(d, "title", {
                    get: desc.get,
                    set(v) {
                        let t = this.querySelector("head > title") || this.querySelector("title");
                        if (!t) { t = this.createElement("title"); (this.head || this.documentElement).appendChild(t); }
                        t.textContent = String(v);
                    },
                    configurable: true, enumerable: false,
                });
            }
        }
        accessorIfMissing(d, "visibilityState", () => "visible");
        accessorIfMissing(d, "hidden", () => false);
        accessorIfMissing(d, "prerendering", () => false);
        defineIfMissing(d, "hasFocus", () => true);
        accessorIfMissing(d, "referrer", () => config().referrer ?? "");
        accessorIfMissing(d, "URL", () => location.href);
        accessorIfMissing(d, "documentURI", () => location.href);
        accessorIfMissing(d, "baseURI", () => { const b = this && this.querySelector ? null : null; const base = document.querySelector("base[href]"); try { return base ? new URL(base.getAttribute("href"), location.href).href : location.href; } catch (e) { return location.href; } });
        accessorIfMissing(d, "location", () => location, (v) => { location.assign(String(v)); });
        accessorIfMissing(d, "domain", () => location.hostname, () => {});
        defineIfMissing(d, "characterSet", "UTF-8"); defineIfMissing(d, "charset", "UTF-8"); defineIfMissing(d, "inputEncoding", "UTF-8");
        defineIfMissing(d, "compatMode", "CSS1Compat");
        defineIfMissing(d, "contentType", "text/html");
        defineIfMissing(d, "designMode", "off");
        accessorIfMissing(d, "doctype", () => ({ name: "html", publicId: "", systemId: "", nodeType: 10, nodeName: "html" }));
        accessorIfMissing(d, "dir", function () { return document.documentElement?.getAttribute("dir") ?? ""; }, function (v) { document.documentElement?.setAttribute("dir", String(v)); });
        accessorIfMissing(d, "lastModified", () => new Date().toLocaleString("en-US"));
        accessorIfMissing(d, "currentScript", () => (typeof __blitz_current_script === "function" ? __blitz_current_script() : null));
        accessorIfMissing(d, "forms", function () { return this.querySelectorAll("form"); });
        accessorIfMissing(d, "images", function () { return this.querySelectorAll("img"); });
        accessorIfMissing(d, "links", function () { return this.querySelectorAll("a[href], area[href]"); });
        accessorIfMissing(d, "scripts", function () { return this.querySelectorAll("script"); });
        accessorIfMissing(d, "embeds", function () { return this.querySelectorAll("embed"); });
        accessorIfMissing(d, "plugins", function () { return this.querySelectorAll("embed"); });
        accessorIfMissing(d, "anchors", function () { return this.querySelectorAll("a[name]"); });
        accessorIfMissing(d, "children", function () { return this.documentElement ? [this.documentElement] : []; });
        accessorIfMissing(d, "fullscreenElement", () => null);
        accessorIfMissing(d, "fullscreenEnabled", () => false);
        accessorIfMissing(d, "pointerLockElement", () => null);
        accessorIfMissing(d, "pictureInPictureElement", () => null);
        defineIfMissing(d, "pictureInPictureEnabled", false);
        defineIfMissing(d, "exitFullscreen", () => Promise.resolve());
        defineIfMissing(d, "exitPointerLock", () => {});
        defineIfMissing(d, "getElementsByName", function (name) { return this.querySelectorAll(`[name="${String(name).replace(/"/g, '\\"')}"]`); });
        defineIfMissing(d, "getRootNode", function () { return this; });
        defineIfMissing(d, "importNode", function (node, deep) { return node.cloneNode(!!deep); });
        defineIfMissing(d, "adoptNode", function (node) { return node; });
        defineIfMissing(d, "execCommand", () => false);
        defineIfMissing(d, "queryCommandSupported", () => false);
        defineIfMissing(d, "queryCommandEnabled", () => false);
        defineIfMissing(d, "queryCommandState", () => false);
        defineIfMissing(d, "queryCommandValue", () => "");
        defineIfMissing(d, "open", function () { return this; });
        defineIfMissing(d, "close", function () {});
        defineIfMissing(d, "write", function (html) { (this.body ?? this.documentElement)?.insertAdjacentHTML("beforeend", String(html)); });
        defineIfMissing(d, "writeln", function (html) { this.write(String(html) + "\n"); });
        defineIfMissing(d, "caretPositionFromPoint", () => null);
        defineIfMissing(d, "caretRangeFromPoint", () => null);
        defineIfMissing(d, "startViewTransition", function (cb) { const p = Promise.resolve().then(() => (typeof cb === "function" ? cb() : undefined)); return { ready: p, finished: p, updateCallbackDone: p, skipTransition() {} }; });
        defineIfMissing(d, "createEvent", function (iface) {
            const map = { Event: Event, Events: Event, HTMLEvents: Event, UIEvent: UIEvent, UIEvents: UIEvent, MouseEvent: MouseEvent, MouseEvents: MouseEvent, CustomEvent: CustomEvent, KeyboardEvent: KeyboardEvent, FocusEvent: globalThis.FocusEvent, TouchEvent: globalThis.TouchEvent, MessageEvent: globalThis.MessageEvent };
            const cls = map[iface] ?? Event;
            return new cls("", {});
        });
        defineIfMissing(d, "createAttribute", function (name) { return { name: String(name).toLowerCase(), localName: String(name).toLowerCase(), value: "", nodeType: 2, ownerElement: null, specified: true }; });
        defineIfMissing(d, "createAttributeNS", function (ns, name) { return this.createAttribute(name); });
        defineIfMissing(d, "createProcessingInstruction", function () { return this.createComment(""); });
        defineIfMissing(d, "createCDATASection", function (t) { return this.createTextNode(t); });
        defineIfMissing(d, "createExpression", () => { throw new DOMException("XPath is not supported", "NotSupportedError"); });
        defineIfMissing(d, "evaluate", () => { throw new DOMException("XPath is not supported", "NotSupportedError"); });
        if (!("fonts" in d)) {
            const fonts = new EventTarget();
            Object.assign(fonts, { ready: Promise.resolve(fonts), status: "loaded", size: 0, check: () => true, load: () => Promise.resolve([]), add() { return this; }, delete() { return false; }, clear() {}, has: () => false, forEach() {}, values: () => [][Symbol.iterator](), keys: () => [][Symbol.iterator](), entries: () => [][Symbol.iterator](), [Symbol.iterator]: () => [][Symbol.iterator](), onloading: null, onloadingdone: null, onloadingerror: null });
            define(d, "fonts", fonts);
            globalThis.FontFace = class FontFace { constructor(family, source, descriptors = {}) { this.family = family; this.status = "unloaded"; Object.assign(this, descriptors); this.loaded = Promise.resolve(this); } load() { this.status = "loaded"; return Promise.resolve(this); } };
        }
        accessorIfMissing(d, "adoptedStyleSheets", () => [], () => {});
        accessorIfMissing(d, "timeline", () => ({ currentTime: performance.now() }));
        accessorIfMissing(d, "implementation", () => ({
            hasFeature: () => true,
            createHTMLDocument(title) { return makeDetachedDocument(title === undefined ? "" : String(title)); },
            createDocument() { return makeDetachedDocument(""); },
            createDocumentType: (name, publicId, systemId) => ({ name, publicId, systemId, nodeType: 10 }),
        }));
        // cookie
        if (!("cookie" in d) && typeof __blitz_cookie_get === "function") {
            accessor(d, "cookie", () => __blitz_cookie_get(), (v) => { __blitz_cookie_set(String(v)); });
        } else if (!("cookie" in d)) {
            let jar = "";
            accessor(d, "cookie", () => jar, (v) => { jar = String(v).split(";")[0]; });
        }

        // DOMParser / 切り離されたドキュメント: template の content(フラグメント)で代用する
        const makeDetachedDocument = (title, html) => {
            const tpl = document.createElement("template");
            if (html !== undefined) tpl.innerHTML = html;
            const frag = tpl.content;
            const find = (tag) => { for (const c of frag.childNodes) if (c.nodeType === 1 && c.localName === tag) return c; return null; };
            let htmlEl = find("html");
            const docLike = Object.create(fragmentProto);
            const bodyEl = () => (htmlEl ? htmlEl.querySelector("body") : null) ?? frag;
            Object.defineProperties(docLike, {
                nodeType: { value: 9 }, nodeName: { value: "#document" }, title: { value: title, writable: true },
                documentElement: { get: () => htmlEl ?? frag }, head: { get: () => (htmlEl ? htmlEl.querySelector("head") : null) ?? frag }, body: { get: () => bodyEl() },
                childNodes: { get: () => frag.childNodes }, firstChild: { get: () => frag.firstChild }, children: { get: () => frag.children },
                textContent: { get: () => frag.textContent }, _fragment: { value: frag },
                querySelector: { value: (s) => frag.querySelector(s) }, querySelectorAll: { value: (s) => frag.querySelectorAll(s) },
                getElementById: { value: (id) => frag.querySelector("#" + CSS.escape(String(id))) },
                getElementsByTagName: { value: (t) => frag.querySelectorAll(t) }, getElementsByClassName: { value: (c) => frag.querySelectorAll("." + String(c).trim().split(/\s+/).map(CSS.escape).join(".")) },
                createElement: { value: (t) => document.createElement(t) }, createElementNS: { value: (ns, t) => document.createElementNS(ns, t) },
                createTextNode: { value: (t) => document.createTextNode(t) }, createComment: { value: (t) => document.createComment(t) },
                createDocumentFragment: { value: () => document.createDocumentFragment() },
                importNode: { value: (n, deep) => n.cloneNode(!!deep) }, adoptNode: { value: (n) => n },
                appendChild: { value: (n) => frag.appendChild(n) }, contains: { value: (n) => frag.contains(n) },
                addEventListener: { value() {} }, removeEventListener: { value() {} }, dispatchEvent: { value: () => true },
                defaultView: { value: null }, ownerDocument: { value: null }, implementation: { get: () => document.implementation },
                readyState: { value: "complete" }, cookie: { value: "", writable: true }, location: { value: null },
            });
            return docLike;
        };
        if (typeof globalThis.DOMParser === "undefined") {
            class DOMParser {
                parseFromString(str, type) {
                    if (type && type !== "text/html") {
                        // XML/SVG: タグをそのまま HTML パーサに通す(近似)
                        return makeDetachedDocument("", String(str));
                    }
                    return makeDetachedDocument("", String(str));
                }
            }
            globalThis.DOMParser = DOMParser;
        }
        if (typeof globalThis.XMLSerializer === "undefined") {
            globalThis.XMLSerializer = class XMLSerializer { serializeToString(node) { return node.outerHTML ?? node.textContent ?? ""; } };
        }

        // Range / Selection(最小限)
        if (typeof globalThis.Range === "undefined") {
            class Range {
                constructor() { this.startContainer = document; this.startOffset = 0; this.endContainer = document; this.endOffset = 0; }
                get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
                get commonAncestorContainer() { let a = this.startContainer; while (a && !(a.contains ? a.contains(this.endContainer) : false)) a = a.parentNode; return a ?? document; }
                setStart(n, o) { this.startContainer = n; this.startOffset = o; }
                setEnd(n, o) { this.endContainer = n; this.endOffset = o; }
                setStartBefore(n) { this.setStart(n.parentNode, indexOf(n)); } setStartAfter(n) { this.setStart(n.parentNode, indexOf(n) + 1); }
                setEndBefore(n) { this.setEnd(n.parentNode, indexOf(n)); } setEndAfter(n) { this.setEnd(n.parentNode, indexOf(n) + 1); }
                selectNode(n) { this.setStartBefore(n); this.setEndAfter(n); }
                selectNodeContents(n) { this.setStart(n, 0); this.setEnd(n, n.nodeType === 3 ? n.data.length : n.childNodes.length); }
                collapse(toStart) { if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; } else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; } }
                cloneRange() { const r = new Range(); r.setStart(this.startContainer, this.startOffset); r.setEnd(this.endContainer, this.endOffset); return r; }
                cloneContents() { const f = document.createDocumentFragment(); if (this.startContainer === this.endContainer && this.startContainer.nodeType === 3) f.appendChild(document.createTextNode(this.startContainer.data.slice(this.startOffset, this.endOffset))); return f; }
                extractContents() { return this.cloneContents(); }
                deleteContents() { if (this.startContainer === this.endContainer && this.startContainer.nodeType === 3) { const t = this.startContainer; t.data = t.data.slice(0, this.startOffset) + t.data.slice(this.endOffset); } }
                insertNode(n) { const c = this.startContainer; if (c.nodeType === 3) { c.parentNode.insertBefore(n, c.nextSibling); } else { c.insertBefore(n, c.childNodes[this.startOffset] ?? null); } }
                surroundContents(n) { this.insertNode(n); }
                getBoundingClientRect() { const el = this.startContainer.nodeType === 1 ? this.startContainer : this.startContainer.parentElement; return el ? el.getBoundingClientRect() : new DOMRect(0, 0, 0, 0); }
                getClientRects() { return [this.getBoundingClientRect()]; }
                toString() { if (this.startContainer === this.endContainer && this.startContainer.nodeType === 3) return this.startContainer.data.slice(this.startOffset, this.endOffset); return this.commonAncestorContainer.textContent ?? ""; }
                detach() {}
                compareBoundaryPoints() { return 0; }
                comparePoint() { return 0; }
                intersectsNode() { return false; }
                isPointInRange() { return false; }
                createContextualFragment(html) { const t = document.createElement("template"); t.innerHTML = html; return t.content; }
            }
            Range.START_TO_START = 0; Range.START_TO_END = 1; Range.END_TO_END = 2; Range.END_TO_START = 3;
            const indexOf = (n) => { let i = 0; let s = n; while ((s = s.previousSibling)) i++; return i; };
            globalThis.Range = Range;
            defineIfMissing(d, "createRange", () => new Range());
            globalThis.StaticRange = class StaticRange extends Range { constructor(init) { super(); this.setStart(init.startContainer, init.startOffset); this.setEnd(init.endContainer, init.endOffset); } };
        }
        // Selection: ネイティブ(描画用の setBaseAndExtent / removeAllRanges / toString)を包み、
        // Draft.js などが読む anchorNode/focusNode/rangeCount/getRangeAt/addRange を JS 側で持つ
        if (typeof globalThis.Selection === "undefined") {
            const sel = getSelection();
            globalThis.Selection = function Selection() { throw new TypeError("Illegal constructor"); };
            if (sel) {
                const nativeSet = sel.setBaseAndExtent.bind(sel);
                const nativeClear = sel.removeAllRanges.bind(sel);
                const nativeToString = sel.toString.bind(sel);
                const st = { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 };
                const notify = () => { try { document.dispatchEvent(new Event("selectionchange")); } catch {} };
                const clampOffset = (node, off) => { if (!node) return 0; const max = node.nodeType === 3 ? node.data.length : node.childNodes.length; return Math.max(0, Math.min(off | 0, max)); };
                const setPoints = (an, ao, fn, fo) => {
                    st.anchorNode = an; st.anchorOffset = clampOffset(an, ao); st.focusNode = fn; st.focusOffset = clampOffset(fn, fo);
                    try { if (an && fn) nativeSet(an, st.anchorOffset, fn, st.focusOffset); else nativeClear(); } catch {}
                    notify();
                };
                const isBefore = (n1, o1, n2, o2) => {
                    if (n1 === n2) return o1 <= o2;
                    const pos = n1.compareDocumentPosition(n2);
                    if (pos & 2) return false; // n2 precedes n1
                    if (pos & 4) return true;
                    return true;
                };
                const props = {
                    anchorNode: { get: () => st.anchorNode },
                    anchorOffset: { get: () => st.anchorOffset },
                    focusNode: { get: () => st.focusNode },
                    focusOffset: { get: () => st.focusOffset },
                    baseNode: { get: () => st.anchorNode },
                    baseOffset: { get: () => st.anchorOffset },
                    extentNode: { get: () => st.focusNode },
                    extentOffset: { get: () => st.focusOffset },
                    rangeCount: { get: () => (st.anchorNode ? 1 : 0) },
                    isCollapsed: { get: () => !st.anchorNode || (st.anchorNode === st.focusNode && st.anchorOffset === st.focusOffset) },
                    type: { get: () => (!st.anchorNode ? "None" : (st.anchorNode === st.focusNode && st.anchorOffset === st.focusOffset) ? "Caret" : "Range") },
                    direction: { get: () => (!st.anchorNode ? "none" : isBefore(st.anchorNode, st.anchorOffset, st.focusNode, st.focusOffset) ? "forward" : "backward") },
                };
                for (const [k, d] of Object.entries(props)) Object.defineProperty(sel, k, { ...d, configurable: true, enumerable: true });
                const methods = {
                    getRangeAt(i) {
                        if (!st.anchorNode || (i | 0) !== 0) throw new DOMException("Index or size is negative or greater than the allowed amount", "IndexSizeError");
                        const r = document.createRange();
                        if (isBefore(st.anchorNode, st.anchorOffset, st.focusNode, st.focusOffset)) { r.setStart(st.anchorNode, st.anchorOffset); r.setEnd(st.focusNode, st.focusOffset); }
                        else { r.setStart(st.focusNode, st.focusOffset); r.setEnd(st.anchorNode, st.anchorOffset); }
                        return r;
                    },
                    addRange(r) { setPoints(r.startContainer, r.startOffset, r.endContainer, r.endOffset); },
                    removeRange(r) { this.removeAllRanges(); },
                    removeAllRanges() { st.anchorNode = st.focusNode = null; st.anchorOffset = st.focusOffset = 0; try { nativeClear(); } catch {} notify(); },
                    empty() { this.removeAllRanges(); },
                    collapse(node, offset) { if (node == null) { this.removeAllRanges(); return; } setPoints(node, offset || 0, node, offset || 0); },
                    setPosition(node, offset) { this.collapse(node, offset); },
                    collapseToStart() { if (!st.anchorNode) throw new DOMException("No range", "InvalidStateError"); const r = this.getRangeAt(0); setPoints(r.startContainer, r.startOffset, r.startContainer, r.startOffset); },
                    collapseToEnd() { if (!st.anchorNode) throw new DOMException("No range", "InvalidStateError"); const r = this.getRangeAt(0); setPoints(r.endContainer, r.endOffset, r.endContainer, r.endOffset); },
                    extend(node, offset) { if (!st.anchorNode) throw new DOMException("No range", "InvalidStateError"); setPoints(st.anchorNode, st.anchorOffset, node, offset || 0); },
                    setBaseAndExtent(an, ao, fn, fo) { setPoints(an, ao, fn, fo); },
                    selectAllChildren(node) { setPoints(node, 0, node, node.childNodes.length); },
                    modify() {},
                    deleteFromDocument() { if (!st.anchorNode) return; try { this.getRangeAt(0).deleteContents(); } catch {} this.collapseToStart(); },
                    containsNode(node, partial) { if (!st.anchorNode || !node) return false; const r = this.getRangeAt(0); try { return partial ? r.intersectsNode(node) : (r.comparePoint(node, 0) === 0 && r.comparePoint(node, node.nodeType === 3 ? node.data.length : node.childNodes.length) === 0); } catch { return false; } },
                    toString() { try { if (st.anchorNode && st.anchorNode === st.focusNode && st.anchorNode.nodeType === 3) { const [a, b] = [st.anchorOffset, st.focusOffset].sort((x, y) => x - y); return st.anchorNode.data.slice(a, b); } return this.getRangeAt(0).toString(); } catch { return nativeToString(); } },
                };
                for (const [k, f] of Object.entries(methods)) Object.defineProperty(sel, k, { value: f, writable: true, configurable: true, enumerable: false });
                Selection.prototype = Object.getPrototypeOf(sel);
                Object.defineProperty(sel, Symbol.toStringTag, { value: "Selection", configurable: true });
            }
        }
        if (typeof globalThis.TreeWalker === "undefined") {
            const FILTER_ACCEPT = 1, FILTER_REJECT = 2, FILTER_SKIP = 3;
            const SHOW_ALL = 0xffffffff;
            const accept = (walker, node) => {
                if (!((1 << (node.nodeType - 1)) & walker.whatToShow)) return FILTER_SKIP;
                const f = walker.filter;
                if (!f) return FILTER_ACCEPT;
                const r = typeof f === "function" ? f(node) : f.acceptNode(node);
                return r === undefined ? FILTER_ACCEPT : r;
            };
            class TreeWalker {
                constructor(root, whatToShow = SHOW_ALL, filter = null) { this.root = root; this.whatToShow = whatToShow; this.filter = filter; this.currentNode = root; }
                parentNode() { let n = this.currentNode; while (n && n !== this.root) { n = n.parentNode; if (n && accept(this, n) === FILTER_ACCEPT) { this.currentNode = n; return n; } } return null; }
                firstChild() { return this._child(true); }
                lastChild() { return this._child(false); }
                _child(first) {
                    let n = first ? this.currentNode.firstChild : this.currentNode.lastChild;
                    while (n) {
                        const r = accept(this, n);
                        if (r === FILTER_ACCEPT) { this.currentNode = n; return n; }
                        if (r === FILTER_SKIP) { const c = first ? n.firstChild : n.lastChild; if (c) { n = c; continue; } }
                        while (n) { const s = first ? n.nextSibling : n.previousSibling; if (s) { n = s; break; } n = n.parentNode; if (!n || n === this.root || n === this.currentNode) return null; }
                    }
                    return null;
                }
                nextSibling() { return this._sibling(true); }
                previousSibling() { return this._sibling(false); }
                _sibling(next) {
                    let n = this.currentNode;
                    if (n === this.root) return null;
                    while (true) {
                        let s = next ? n.nextSibling : n.previousSibling;
                        while (s) {
                            const r = accept(this, s);
                            if (r === FILTER_ACCEPT) { this.currentNode = s; return s; }
                            const c = next ? s.firstChild : s.lastChild;
                            if (r === FILTER_REJECT || !c) s = next ? s.nextSibling : s.previousSibling; else s = c;
                        }
                        n = n.parentNode;
                        if (!n || n === this.root) return null;
                        if (accept(this, n) === FILTER_ACCEPT) return null;
                    }
                }
                nextNode() {
                    let n = this.currentNode;
                    let result = FILTER_ACCEPT;
                    while (true) {
                        while (result !== FILTER_REJECT && n.firstChild) { n = n.firstChild; result = accept(this, n); if (result === FILTER_ACCEPT) { this.currentNode = n; return n; } }
                        let s = null, t = n;
                        while (t && t !== this.root) { s = t.nextSibling; if (s) break; t = t.parentNode; }
                        if (!s) return null;
                        n = s; result = accept(this, n);
                        if (result === FILTER_ACCEPT) { this.currentNode = n; return n; }
                    }
                }
                previousNode() {
                    let n = this.currentNode;
                    while (n !== this.root) {
                        let s = n.previousSibling;
                        while (s) {
                            n = s;
                            let r = accept(this, n);
                            while (r !== FILTER_REJECT && n.lastChild) { n = n.lastChild; r = accept(this, n); }
                            if (r === FILTER_ACCEPT) { this.currentNode = n; return n; }
                            s = n.previousSibling;
                        }
                        if (n === this.root || !n.parentNode) return null;
                        n = n.parentNode;
                        if (accept(this, n) === FILTER_ACCEPT) { this.currentNode = n; return n; }
                    }
                    return null;
                }
            }
            class NodeIterator {
                constructor(root, whatToShow = SHOW_ALL, filter = null) { this.root = root; this.whatToShow = whatToShow; this.filter = filter; this.referenceNode = root; this.pointerBeforeReferenceNode = true; this._walker = new TreeWalker(root, whatToShow, filter); this._first = true; }
                nextNode() { if (this._first) { this._first = false; if (accept(this._walker, this.root) === FILTER_ACCEPT) { this.referenceNode = this.root; return this.root; } } const n = this._walker.nextNode(); if (n) this.referenceNode = n; return n; }
                previousNode() { const n = this._walker.previousNode(); if (n) this.referenceNode = n; return n; }
                detach() {}
            }
            globalThis.TreeWalker = TreeWalker;
            globalThis.NodeIterator = NodeIterator;
            globalThis.NodeFilter = { FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP, SHOW_ALL, SHOW_ELEMENT: 1, SHOW_ATTRIBUTE: 2, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8, SHOW_PROCESSING_INSTRUCTION: 64, SHOW_COMMENT: 128, SHOW_DOCUMENT: 256, SHOW_DOCUMENT_TYPE: 512, SHOW_DOCUMENT_FRAGMENT: 1024 };
            defineIfMissing(d, "createTreeWalker", (root, whatToShow, filter) => new TreeWalker(root, whatToShow, filter));
            defineIfMissing(d, "createNodeIterator", (root, whatToShow, filter) => new NodeIterator(root, whatToShow, filter));
        }
    }

    // =========================================================================
    // Node / Element
    // =========================================================================
    {
        const n = nodeProto;
        for (const [k, v] of Object.entries({ ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3, CDATA_SECTION_NODE: 4, ENTITY_REFERENCE_NODE: 5, ENTITY_NODE: 6, PROCESSING_INSTRUCTION_NODE: 7, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10, DOCUMENT_FRAGMENT_NODE: 11, NOTATION_NODE: 12, DOCUMENT_POSITION_DISCONNECTED: 1, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINS: 8, DOCUMENT_POSITION_CONTAINED_BY: 16, DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32 })) {
            defineIfMissing(n, k, v); defineIfMissing(Node, k, v);
        }
        accessorIfMissing(n, "baseURI", () => document.baseURI);
        defineIfMissing(n, "getRootNode", function () { let r = this; while (r.parentNode) r = r.parentNode; return r; });
        defineIfMissing(n, "isSameNode", function (o) { return this === o; });
        defineIfMissing(n, "isEqualNode", function (o) { if (!o || o.nodeType !== this.nodeType) return false; if (this.nodeType === 1) return this.outerHTML === o.outerHTML; return this.textContent === o.textContent; });
        defineIfMissing(n, "hasAttributes", function () { return this.nodeType === 1 && this.getAttributeNames().length > 0; });
        defineIfMissing(n, "lookupNamespaceURI", function (prefix) { return prefix === "svg" ? "http://www.w3.org/2000/svg" : (this.namespaceURI ?? null); });
        defineIfMissing(n, "lookupPrefix", () => null);
        defineIfMissing(n, "isDefaultNamespace", function (ns) { return (this.namespaceURI ?? "http://www.w3.org/1999/xhtml") === ns; });
        defineIfMissing(n, "normalize", function () {
            const walk = (node) => {
                let c = node.firstChild;
                while (c) {
                    const next = c.nextSibling;
                    if (c.nodeType === 3) {
                        if (c.data === "") { node.removeChild(c); }
                        else { let s = c.nextSibling; while (s && s.nodeType === 3) { c.data += s.data; const dead = s; s = s.nextSibling; node.removeChild(dead); } }
                    } else if (c.nodeType === 1) walk(c);
                    c = c.nextSibling === next ? next : c.nextSibling;
                    if (c === null) break;
                }
            };
            walk(this);
        });
        defineIfMissing(n, "compareDocumentPosition", function (other) {
            if (this === other) return 0;
            const path = (x) => { const p = []; while (x) { p.unshift(x); x = x.parentNode; } return p; };
            const a = path(this), b = path(other);
            if (a[0] !== b[0]) return 1 | 32 | (Math.random() < 0.5 ? 2 : 4);
            let i = 0;
            while (i < a.length && i < b.length && a[i] === b[i]) i++;
            if (i === a.length) return 16 | 4;
            if (i === b.length) return 8 | 2;
            const parent = a[i - 1];
            for (const c of parent.childNodes) { if (c === a[i]) return 4; if (c === b[i]) return 2; }
            return 4;
        });

        const e = elementProto;
        const insertPos = (el, where, nodes) => {
            switch (String(where).toLowerCase()) {
                case "beforebegin": if (!el.parentNode) return null; for (const x of nodes) el.parentNode.insertBefore(x, el); break;
                case "afterbegin": { const first = el.firstChild; for (const x of nodes) el.insertBefore(x, first); break; }
                case "beforeend": for (const x of nodes) el.appendChild(x); break;
                case "afterend": if (!el.parentNode) return null; { const next = el.nextSibling; for (const x of nodes) el.parentNode.insertBefore(x, next); } break;
                default: throw new DOMException("The value provided ('" + where + "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.", "SyntaxError");
            }
        };
        defineIfMissing(e, "insertAdjacentHTML", function (where, html) {
            const t = document.createElement("template");
            t.innerHTML = String(html);
            insertPos(this, where, [t.content]);
        });
        defineIfMissing(e, "insertAdjacentElement", function (where, el) { insertPos(this, where, [el]); return el; });
        defineIfMissing(e, "insertAdjacentText", function (where, text) { insertPos(this, where, [document.createTextNode(String(text))]); });
        defineIfMissing(e, "toggleAttribute", function (name, force) {
            const has = this.hasAttribute(name);
            if (force === undefined ? has : !force) { if (has) this.removeAttribute(name); return false; }
            if (!has) this.setAttribute(name, "");
            return true;
        });
        defineIfMissing(e, "getAttributeNS", function (ns, name) { return this.getAttribute(name); });
        defineIfMissing(e, "setAttributeNS", function (ns, name, value) { this.setAttribute(name, value); });
        defineIfMissing(e, "removeAttributeNS", function (ns, name) { this.removeAttribute(name); });
        defineIfMissing(e, "hasAttributeNS", function (ns, name) { return this.hasAttribute(name); });
        defineIfMissing(e, "getAttributeNode", function (name) { const v = this.getAttribute(name); return v === null ? null : { name: String(name), localName: String(name), value: v, nodeValue: v, nodeType: 2, ownerElement: this, specified: true }; });
        defineIfMissing(e, "getAttributeNodeNS", function (ns, name) { return this.getAttributeNode(name); });
        defineIfMissing(e, "setAttributeNode", function (attr) { const old = this.getAttributeNode(attr.name); this.setAttribute(attr.name, attr.value); return old; });
        defineIfMissing(e, "setAttributeNodeNS", function (attr) { return this.setAttributeNode(attr); });
        defineIfMissing(e, "removeAttributeNode", function (attr) { this.removeAttribute(attr.name); return attr; });
        defineIfMissing(e, "attachShadow", function () { throw new DOMException("Shadow DOM is not supported", "NotSupportedError"); });
        accessorIfMissing(e, "shadowRoot", () => null);
        accessorIfMissing(e, "assignedSlot", () => null);
        // ---- Web Animations API(最小実装)----------------------------------------
        // X のトランザクション ID 生成は element.animate() → currentTime 設定 → getComputedStyle で
        // 補間された color / transform を読む。スタイルエンジンは触らず、JS で補間して
        // getComputedStyle の結果に上書きする。
        const waapi = (() => {
            const animationsOf = new WeakMap();
            const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
            // cubic-bezier: x(t) から t を求め y(t) を返す(Chromium と同じく二分法)
            const bezier = (x1, y1, x2, y2) => (x) => {
                if (x <= 0) { const g = x1 > 0 ? y1 / x1 : (y1 === 0 && x2 > 0 ? y2 / x2 : 0); return g * x; }
                if (x >= 1) { const g = x2 < 1 ? (y2 - 1) / (x2 - 1) : (x2 === 1 && x1 < 1 ? (y1 - 1) / (x1 - 1) : 0); return 1 + g * (x - 1); }
                const calc = (a, b, m) => 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
                let lo = 0, hi = 1, mid = 0;
                while (lo < hi) {
                    mid = (lo + hi) / 2;
                    const est = calc(x1, x2, mid);
                    if (Math.abs(x - est) < 0.00001) return calc(y1, y2, mid);
                    if (est < x) lo = mid; else hi = mid;
                }
                return calc(y1, y2, mid);
            };
            const parseEasing = (e) => {
                e = String(e || "linear").trim();
                if (e === "linear") return (x) => x;
                if (e === "ease") return bezier(0.25, 0.1, 0.25, 1);
                if (e === "ease-in") return bezier(0.42, 0, 1, 1);
                if (e === "ease-out") return bezier(0, 0, 0.58, 1);
                if (e === "ease-in-out") return bezier(0.42, 0, 0.58, 1);
                const m = e.match(/^cubic-bezier\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)$/);
                if (m) return bezier(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4]));
                const st = e.match(/^steps\((\d+)(?:,\s*([a-z-]+))?\)$/);
                if (st) { const n = Number(st[1]); const jump = st[2] || "end"; return (x) => { let k = jump === "start" || jump === "jump-start" ? Math.ceil(x * n) : Math.floor(x * n); if (x >= 1) k = n; return k / n; }; }
                return (x) => x;
            };
            const NAMED = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], transparent: [0, 0, 0, 0], gray: [128, 128, 128], grey: [128, 128, 128], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255], orange: [255, 165, 0] };
            const parseColor = (v) => {
                v = String(v).trim().toLowerCase();
                if (v in NAMED) { const c = NAMED[v]; return [c[0], c[1], c[2], c.length > 3 ? c[3] : 1]; }
                let m = v.match(/^#([0-9a-f]{3,8})$/);
                if (m) {
                    const h = m[1];
                    if (h.length === 3 || h.length === 4) { const r = parseInt(h[0] + h[0], 16), g = parseInt(h[1] + h[1], 16), b = parseInt(h[2] + h[2], 16), a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1; return [r, g, b, a]; }
                    if (h.length === 6 || h.length === 8) { return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1]; }
                }
                m = v.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/);
                if (m) { let a = 1; if (m[4] !== undefined) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]); return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a]; }
                return null;
            };
            const fmtNum = (n) => { if (Object.is(n, -0) || Math.abs(n) < 1e-7) return "0"; const s = Number(n.toFixed(6)).toString(); return s; };
            const serializeColor = (c) => {
                const r = Math.round(Math.min(255, Math.max(0, c[0]))), g = Math.round(Math.min(255, Math.max(0, c[1]))), b = Math.round(Math.min(255, Math.max(0, c[2])));
                const a = Math.min(1, Math.max(0, c[3]));
                return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${fmtNum(a)})`;
            };
            // transform: 関数列を 2D 行列に畳み込む
            const parseTransform = (v) => {
                v = String(v).trim();
                if (v === "none" || v === "") return [];
                const out = [];
                const re = /([a-zA-Z0-9]+)\(([^)]*)\)/g;
                let m;
                while ((m = re.exec(v))) out.push({ fn: m[1].toLowerCase(), args: m[2].split(/[\s,]+/).filter(Boolean).map((a) => ({ n: parseFloat(a), unit: a.replace(/^[-+.\d e]+/i, "") })) });
                return out;
            };
            const angleToDeg = (a) => (a.unit === "rad" ? (a.n * 180) / Math.PI : a.unit === "turn" ? a.n * 360 : a.unit === "grad" ? a.n * 0.9 : a.n);
            const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
            const toMatrix = (fns) => {
                let M = [1, 0, 0, 1, 0, 0];
                for (const f of fns) {
                    let m = [1, 0, 0, 1, 0, 0];
                    const a = f.args;
                    switch (f.fn) {
                        case "rotate": case "rotatez": { const r = (angleToDeg(a[0]) * Math.PI) / 180; m = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]; break; }
                        case "scale": m = [a[0].n, 0, 0, a.length > 1 ? a[1].n : a[0].n, 0, 0]; break;
                        case "scalex": m = [a[0].n, 0, 0, 1, 0, 0]; break;
                        case "scaley": m = [1, 0, 0, a[0].n, 0, 0]; break;
                        case "translate": m = [1, 0, 0, 1, a[0].n, a.length > 1 ? a[1].n : 0]; break;
                        case "translatex": m = [1, 0, 0, 1, a[0].n, 0]; break;
                        case "translatey": m = [1, 0, 0, 1, 0, a[0].n]; break;
                        case "skewx": m = [1, 0, Math.tan((angleToDeg(a[0]) * Math.PI) / 180), 1, 0, 0]; break;
                        case "skewy": m = [1, Math.tan((angleToDeg(a[0]) * Math.PI) / 180), 0, 1, 0, 0]; break;
                        case "matrix": m = a.map((x) => x.n); break;
                        default: break;
                    }
                    M = mul(M, m);
                }
                return M;
            };
            const serializeMatrix = (M) => `matrix(${M.map(fmtNum).join(", ")})`;
            const interpolateValue = (prop, from, to, p) => {
                if (prop === "color" || prop.endsWith("Color") || prop.endsWith("-color")) {
                    const a = parseColor(from), b = parseColor(to);
                    if (a && b) {
                        // alpha 事前乗算で補間
                        const pa = a[3], pb = b[3];
                        const alpha = pa + (pb - pa) * p;
                        const ch = (i) => (alpha === 0 ? 0 : (a[i] * pa + (b[i] * pb - a[i] * pa) * p) / alpha);
                        return serializeColor([ch(0), ch(1), ch(2), alpha]);
                    }
                }
                if (prop === "transform") {
                    const A = parseTransform(from), B = parseTransform(to);
                    if (A.length === B.length && A.every((f, i) => f.fn === B[i].fn && f.args.length === B[i].args.length)) {
                        const fns = A.map((f, i) => ({ fn: f.fn, args: f.args.map((arg, j) => ({ n: arg.n + (B[i].args[j].n - arg.n) * p, unit: arg.unit })) }));
                        if (!fns.length) return "none";
                        return serializeMatrix(toMatrix(fns));
                    }
                    if (!A.length && !B.length) return "none";
                    // 形が違う場合は行列同士を線形補間(近似)
                    const MA = toMatrix(A), MB = toMatrix(B);
                    return serializeMatrix(MA.map((x, i) => x + (MB[i] - x) * p));
                }
                const fa = parseFloat(from), fb = parseFloat(to);
                if (!isNaN(fa) && !isNaN(fb)) {
                    const unit = String(to).replace(/^[-+.\d e]+/i, "");
                    const v = fa + (fb - fa) * p;
                    return unit ? fmtNum(v) + unit : fmtNum(v);
                }
                return p < 0.5 ? from : to;
            };
            const toKebab = (prop) => prop.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
            const normalizeKeyframes = (kf) => {
                let frames = [];
                if (Array.isArray(kf)) {
                    frames = kf.map((f) => ({ ...f }));
                } else if (kf && typeof kf === "object") {
                    const props = Object.keys(kf).filter((k) => k !== "offset" && k !== "easing" && k !== "composite");
                    const n = Math.max(...props.map((k) => (Array.isArray(kf[k]) ? kf[k].length : 1)), 2);
                    for (let i = 0; i < n; i++) {
                        const f = {};
                        for (const k of props) { const v = kf[k]; if (Array.isArray(v)) { if (v.length === n) f[k] = v[i]; else if (v.length === 1) f[k] = v[0]; else if (i === 0) f[k] = v[0]; else if (i === n - 1) f[k] = v[v.length - 1]; } else { if (i === 0 || i === n - 1) f[k] = v; } }
                        if (kf.easing !== undefined) f.easing = Array.isArray(kf.easing) ? kf.easing[Math.min(i, kf.easing.length - 1)] : kf.easing;
                        if (kf.offset !== undefined) f.offset = Array.isArray(kf.offset) ? kf.offset[i] : undefined;
                        frames.push(f);
                    }
                }
                frames = frames.map((f, i) => ({ ...f, offset: f.offset === undefined || f.offset === null ? (frames.length === 1 ? 1 : i / (frames.length - 1)) : Number(f.offset) }));
                return frames;
            };
            class KeyframeEffect {
                constructor(target, keyframes, options) {
                    this.target = target;
                    this._frames = normalizeKeyframes(keyframes);
                    const o = typeof options === "number" ? { duration: options } : { ...(options || {}) };
                    this._timing = { delay: o.delay ?? 0, endDelay: o.endDelay ?? 0, fill: o.fill ?? "auto", iterationStart: o.iterationStart ?? 0, iterations: o.iterations ?? 1, duration: o.duration ?? "auto", direction: o.direction ?? "normal", easing: o.easing ?? "linear" };
                    this.composite = o.composite ?? "replace";
                    this.pseudoElement = o.pseudoElement ?? null;
                }
                getKeyframes() { return this._frames.map((f) => ({ ...f, computedOffset: f.offset, easing: f.easing ?? "linear", composite: "auto" })); }
                setKeyframes(kf) { this._frames = normalizeKeyframes(kf); }
                getTiming() { return { ...this._timing }; }
                updateTiming(t) { Object.assign(this._timing, t || {}); }
                getComputedTiming() {
                    const d = typeof this._timing.duration === "number" ? this._timing.duration : 0;
                    return { ...this._timing, duration: d, activeDuration: d * (this._timing.iterations === Infinity ? Infinity : this._timing.iterations), endTime: this._timing.delay + d * this._timing.iterations + this._timing.endDelay, localTime: null, progress: null, currentIteration: null };
                }
                _valuesAt(localTime) {
                    const d = typeof this._timing.duration === "number" ? this._timing.duration : 0;
                    let p = d > 0 ? (localTime - this._timing.delay) / d : (localTime >= this._timing.delay ? 1 : 0);
                    p = clamp01(p);
                    p = parseEasing(this._timing.easing)(p);
                    const frames = this._frames;
                    const out = {};
                    const props = new Set();
                    for (const f of frames) for (const k of Object.keys(f)) if (k !== "offset" && k !== "easing" && k !== "composite" && k !== "computedOffset") props.add(k);
                    for (const prop of props) {
                        const withProp = frames.filter((f) => f[prop] !== undefined);
                        if (!withProp.length) continue;
                        let a = withProp[0], b = withProp[withProp.length - 1];
                        for (let i = 0; i < withProp.length - 1; i++) { if (p >= withProp[i].offset && p <= withProp[i + 1].offset) { a = withProp[i]; b = withProp[i + 1]; break; } }
                        let local = b.offset === a.offset ? 1 : (p - a.offset) / (b.offset - a.offset);
                        local = clamp01(local);
                        local = parseEasing(a.easing)(local);
                        out[toKebab(prop)] = interpolateValue(prop, String(a[prop]), String(b[prop]), local);
                    }
                    return out;
                }
            }
            class Animation extends EventTarget {
                constructor(effect, timeline) {
                    super();
                    this.effect = effect; this.timeline = timeline ?? document.timeline; this.id = ""; this.playbackRate = 1;
                    this._currentTime = 0; this._state = "idle"; this.onfinish = null; this.oncancel = null; this.onremove = null; this.replaceState = "active"; this.pending = false;
                    this.ready = Promise.resolve(this);
                    this._makeFinished();
                }
                _makeFinished() { this.finished = new Promise((res, rej) => { this._resolveFinished = res; this._rejectFinished = rej; }); this.finished.catch(() => {}); }
                get currentTime() { return this._state === "idle" ? null : this._currentTime; }
                set currentTime(v) { this._currentTime = Number(v) || 0; if (this._state === "idle") this._state = "paused"; }
                get startTime() { return this._state === "running" ? 0 : null; }
                set startTime(v) {}
                get playState() { return this._state; }
                play() { this._state = "running"; const d = this.effect.getComputedTiming().endTime; if (this._state === "running") setTimeout(() => { if (this._state === "running") { this._state = "finished"; this._currentTime = d; this._resolveFinished(this); if (typeof this.onfinish === "function") this.onfinish(new Event("finish")); this.dispatchEvent(new Event("finish")); } }, Math.min(d, 2000)); }
                pause() { if (this._state === "idle") this._currentTime = 0; this._state = "paused"; }
                cancel() { this._state = "idle"; this._currentTime = 0; this._rejectFinished(new DOMException("The user aborted a request.", "AbortError")); this._makeFinished(); if (typeof this.oncancel === "function") this.oncancel(new Event("cancel")); this.dispatchEvent(new Event("cancel")); }
                finish() { this._state = "finished"; this._currentTime = this.effect.getComputedTiming().endTime; this._resolveFinished(this); if (typeof this.onfinish === "function") this.onfinish(new Event("finish")); this.dispatchEvent(new Event("finish")); }
                reverse() { this.playbackRate = -this.playbackRate; this.play(); }
                updatePlaybackRate(r) { this.playbackRate = r; }
                commitStyles() { const el = this.effect && this.effect.target; if (!el) return; const vals = this.effect._valuesAt(this._currentTime); for (const [k, v] of Object.entries(vals)) el.style.setProperty(k, v); }
                persist() { this.replaceState = "persisted"; }
                _active() { return this._state !== "idle"; }
                _values() { return this.effect._valuesAt(this._currentTime); }
            }
            const animate = function (keyframes, options) {
                const effect = new KeyframeEffect(this, keyframes, options);
                const anim = new Animation(effect, document.timeline);
                if (options && typeof options === "object" && options.id) anim.id = options.id;
                let list = animationsOf.get(this);
                if (!list) { list = []; animationsOf.set(this, list); }
                list.push(anim);
                anim.play();
                return anim;
            };
            const getAnimations = function () { return (animationsOf.get(this) || []).filter((a) => a._active()); };
            const animatedValues = (el) => {
                const list = animationsOf.get(el);
                if (!list || !list.length) return null;
                let out = null;
                for (const a of list) { if (!a._active()) continue; const vals = a._values(); if (!out) out = {}; Object.assign(out, vals); }
                return out;
            };
            return { animate, getAnimations, animatedValues, Animation, KeyframeEffect, parseColor, serializeColor, toMatrix, serializeMatrix, parseTransform };
        })();
        define(e, "animate", waapi.animate);
        define(e, "getAnimations", waapi.getAnimations);
        globalThis.Animation = waapi.Animation;
        globalThis.KeyframeEffect = waapi.KeyframeEffect;
        globalThis.__sunameri_waapi = waapi;
        defineIfMissing(documentProto, "getAnimations", function () { const out = []; const walk = (n) => { for (const c of n.children || []) { out.push(...waapi.getAnimations.call(c)); walk(c); } }; walk(this); return out; });
        // getComputedStyle: アニメーション中の値で上書きする
        {
            const nativeGCS = globalThis.getComputedStyle;
            const toKebab = (prop) => prop.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
            globalThis.getComputedStyle = function getComputedStyle(el, pseudo) {
                const cs = nativeGCS.call(this, el, pseudo);
                if (!el || pseudo) return cs;
                return new Proxy(cs, {
                    get(t, p, recv) {
                        const vals = waapi.animatedValues(el);
                        if (vals) {
                            if (p === "getPropertyValue") return (name) => { const k = String(name).toLowerCase(); return k in vals ? vals[k] : t.getPropertyValue(name); };
                            if (typeof p === "string") { const k = p.includes("-") ? p : toKebab(p); if (k in vals) return vals[k]; }
                        }
                        const v = Reflect.get(t, p, t);
                        return typeof v === "function" ? v.bind(t) : v;
                    },
                });
            };
        }
        defineIfMissing(e, "requestFullscreen", () => Promise.reject(new DOMException("not supported", "TypeError")));
        defineIfMissing(e, "requestPointerLock", () => {});
        defineIfMissing(e, "setPointerCapture", () => {});
        defineIfMissing(e, "releasePointerCapture", () => {});
        defineIfMissing(e, "hasPointerCapture", () => false);
        defineIfMissing(e, "checkVisibility", function () { return this.isConnected; });
        defineIfMissing(e, "scrollIntoViewIfNeeded", function () { this.scrollIntoView(); });
        // click(): イベントを送出し、preventDefault されなければ既定動作(リンク遷移・フォーム送信・チェック切替)を行う
        const defaultClickAction = (el) => {
            const anchor = el.closest ? el.closest("a[href], area[href]") : null;
            if (anchor) {
                const target = anchor.getAttribute("target");
                if (target === "_blank") { console.log("[window.open] " + anchor.href); return; }
                if (anchor.hasAttribute("download")) return;
                globalThis.__sunameri_navigate(anchor.href, false);
                return;
            }
            const tag = el.localName;
            const type = (el.getAttribute("type") || "").toLowerCase();
            if (tag === "button" || tag === "input") {
                if (tag === "input" && type === "checkbox") { el.checked = !el.checked; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return; }
                if (tag === "input" && type === "radio") { el.checked = true; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return; }
                const isSubmit = tag === "button" ? (type === "" || type === "submit") : type === "submit" || type === "image";
                const form = el.form;
                if (isSubmit && form) { form.requestSubmit(el); return; }
                if (tag === "button" && type === "reset" && form) form.reset();
            }
            const label = tag === "label" ? el : null;
            if (label && label.control && label.control !== el) label.control.click();
        };
        define(e, "click", function () {
            if (this.disabled) return;
            const ok = this.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 }));
            if (ok) defaultClickAction(this);
        });
        const submitForm = (form, submitter) => {
            const method = String((submitter && submitter.getAttribute("formmethod")) || form.getAttribute("method") || "get").toUpperCase();
            const action = (submitter && submitter.getAttribute("formaction")) || form.getAttribute("action") || location.href;
            const enctype = String((submitter && submitter.getAttribute("formenctype")) || form.getAttribute("enctype") || "application/x-www-form-urlencoded").toLowerCase();
            const fd = new FormData(form);
            if (submitter && submitter.getAttribute("name")) fd.append(submitter.getAttribute("name"), submitter.value ?? submitter.getAttribute("value") ?? "");
            form.dispatchEvent(new FormDataEvent("formdata", { formData: fd }));
            if (method === "GET" || method === "DIALOG") {
                const u = new URL(action, location.href);
                u.search = new URLSearchParams([...fd].map(([k, v]) => [k, v instanceof Blob ? (v.name ?? "") : v])).toString();
                globalThis.__sunameri_navigate(u.href, false);
                return;
            }
            if (enctype === "multipart/form-data") {
                const enc = fd._encode();
                globalThis.__sunameri_navigate(action, false, "POST", utf8DecodeLossy(enc.bytes), enc.contentType);
                return;
            }
            const body = enctype === "text/plain"
                ? [...fd].map(([k, v]) => k + "=" + v + "\r\n").join("")
                : new URLSearchParams([...fd].map(([k, v]) => [k, v instanceof Blob ? (v.name ?? "") : v])).toString();
            globalThis.__sunameri_navigate(action, false, "POST", body, enctype === "text/plain" ? "text/plain" : "application/x-www-form-urlencoded");
        };
        const utf8DecodeLossy = (bytes) => { try { return new TextDecoder().decode(bytes); } catch (err) { return ""; } };
        define(e, "submit", function () { if (this.localName === "form") submitForm(this, null); });
        define(e, "requestSubmit", function (submitter) {
            if (this.localName !== "form") return;
            if (submitter && submitter.form !== this) throw new DOMException("submitter is not owned by this form", "NotFoundError");
            if (typeof this.reportValidity === "function" && !this.reportValidity()) return;
            const ok = this.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: submitter ?? null }));
            if (ok) submitForm(this, submitter ?? null);
        });
        defineIfMissing(e, "computedStyleMap", function () { const cs = getComputedStyle(this); return { get: (p) => ({ toString: () => cs.getPropertyValue(p), value: cs.getPropertyValue(p) }), has: () => true, size: 0 }; });
        defineIfMissing(e, "getBoxQuads", function () { const r = this.getBoundingClientRect(); return [{ p1: { x: r.left, y: r.top }, p2: { x: r.right, y: r.top }, p3: { x: r.right, y: r.bottom }, p4: { x: r.left, y: r.bottom }, getBounds: () => r }]; });
        accessorIfMissing(e, "part", function () { return tokenList(this, "part"); });
        accessorIfMissing(e, "isContentEditable", function () { let el = this; while (el && el.nodeType === 1) { const v = el.getAttribute("contenteditable"); if (v !== null) return v === "" || v.toLowerCase() === "true" || v.toLowerCase() === "plaintext-only"; el = el.parentElement; } return false; });
        accessorIfMissing(e, "contentEditable", function () { const v = this.getAttribute("contenteditable"); return v === null ? "inherit" : (v === "" ? "true" : v); }, function (v) { if (String(v) === "inherit") this.removeAttribute("contenteditable"); else this.setAttribute("contenteditable", String(v)); });
        accessorIfMissing(e, "tabIndex", function () { const v = this.getAttribute("tabindex"); if (v !== null && !isNaN(parseInt(v, 10))) return parseInt(v, 10); return ["a", "button", "input", "select", "textarea", "area", "iframe", "summary"].includes(this.localName) ? 0 : -1; }, function (v) { this.setAttribute("tabindex", String(parseInt(v, 10) || 0)); });
        accessorIfMissing(e, "draggable", function () { const v = this.getAttribute("draggable"); return v === "true" || (v === null && (this.localName === "img" || this.localName === "a")); }, function (v) { this.setAttribute("draggable", v ? "true" : "false"); });
        accessorIfMissing(e, "spellcheck", function () { return this.getAttribute("spellcheck") !== "false"; }, function (v) { this.setAttribute("spellcheck", v ? "true" : "false"); });
        accessorIfMissing(e, "inert", function () { return this.hasAttribute("inert"); }, function (v) { this.toggleAttribute("inert", !!v); });
        accessorIfMissing(e, "translate", function () { return this.getAttribute("translate") !== "no"; }, function (v) { this.setAttribute("translate", v ? "yes" : "no"); });
        accessorIfMissing(e, "accessKey", function () { return this.getAttribute("accesskey") ?? ""; }, function (v) { this.setAttribute("accesskey", String(v)); });
        accessorIfMissing(e, "nonce", function () { return this.getAttribute("nonce") ?? ""; }, function (v) { this.setAttribute("nonce", String(v)); });
        accessorIfMissing(e, "enterKeyHint", function () { return this.getAttribute("enterkeyhint") ?? ""; }, function (v) { this.setAttribute("enterkeyhint", String(v)); });
        accessorIfMissing(e, "inputMode", function () { return this.getAttribute("inputmode") ?? ""; }, function (v) { this.setAttribute("inputmode", String(v)); });
        accessorIfMissing(e, "popover", function () { return this.getAttribute("popover"); }, function (v) { if (v === null) this.removeAttribute("popover"); else this.setAttribute("popover", String(v)); });
        defineIfMissing(e, "showPopover", function () { this.setAttribute("data-popover-open", ""); });
        defineIfMissing(e, "hidePopover", function () { this.removeAttribute("data-popover-open"); });
        defineIfMissing(e, "togglePopover", function () { return this.toggleAttribute("data-popover-open"); });
        accessorIfMissing(e, "dataset", function () {
            const el = this;
            const toAttr = (k) => "data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
            const toKey = (a) => a.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            return new Proxy({}, {
                get(t, k) { if (typeof k === "symbol") return undefined; const v = el.getAttribute(toAttr(k)); return v === null ? undefined : v; },
                set(t, k, v) { el.setAttribute(toAttr(k), String(v)); return true; },
                deleteProperty(t, k) { el.removeAttribute(toAttr(k)); return true; },
                has(t, k) { return typeof k !== "symbol" && el.hasAttribute(toAttr(k)); },
                ownKeys() { return el.getAttributeNames().filter((a) => a.startsWith("data-")).map(toKey); },
                getOwnPropertyDescriptor(t, k) { const v = el.getAttribute(toAttr(k)); return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; },
            });
        });

        // attributes: ライブな NamedNodeMap(React は `for (; attrs.length;) el.removeAttributeNode(attrs[0])` と書く)
        {
            const makeAttr = (el, name) => ({ name, localName: name, nodeName: name, get value() { return el.getAttribute(name) ?? ""; }, set value(v) { el.setAttribute(name, String(v)); }, get nodeValue() { return el.getAttribute(name) ?? ""; }, nodeType: 2, ownerElement: el, specified: true, namespaceURI: null, prefix: null, toString() { return el.getAttribute(name) ?? ""; } });
            const namedNodeMapProto = {
                item(i) { const names = this._el.getAttributeNames(); return i < names.length ? makeAttr(this._el, names[i]) : null; },
                getNamedItem(name) { return this._el.hasAttribute(name) ? makeAttr(this._el, name) : null; },
                getNamedItemNS(ns, name) { return this.getNamedItem(name); },
                setNamedItem(attr) { const old = this.getNamedItem(attr.name); this._el.setAttribute(attr.name, attr.value); return old; },
                setNamedItemNS(attr) { return this.setNamedItem(attr); },
                removeNamedItem(name) { const old = this.getNamedItem(name); if (!old) throw new DOMException("not found", "NotFoundError"); this._el.removeAttribute(name); return old; },
                removeNamedItemNS(ns, name) { return this.removeNamedItem(name); },
                get length() { return this._el.getAttributeNames().length; },
                forEach(cb, thisArg) { this._el.getAttributeNames().forEach((n, i) => cb.call(thisArg, makeAttr(this._el, n), i, this)); },
                *[Symbol.iterator]() { for (const n of this._el.getAttributeNames()) yield makeAttr(this._el, n); },
                entries() { return Array.from(this).entries(); }, keys() { return Array.from(this).keys(); }, values() { return Array.from(this)[Symbol.iterator](); },
                get [Symbol.toStringTag]() { return "NamedNodeMap"; },
            };
            const handler = {
                get(t, p, recv) {
                    if (typeof p === "string" && /^\d+$/.test(p)) return t.item(Number(p)) ?? undefined;
                    if (typeof p === "string" && !(p in t) && t._el.hasAttribute(p)) return makeAttr(t._el, p);
                    return Reflect.get(t, p, recv);
                },
                has(t, p) { if (typeof p === "string" && /^\d+$/.test(p)) return Number(p) < t.length; return p in t; },
                ownKeys(t) { return t._el.getAttributeNames().map((_, i) => String(i)).concat(["length"]); },
                getOwnPropertyDescriptor(t, p) { if (typeof p === "string" && /^\d+$/.test(p) && Number(p) < t.length) return { value: t.item(Number(p)), enumerable: true, configurable: true }; return Reflect.getOwnPropertyDescriptor(t, p); },
            };
            Object.defineProperty(e, "attributes", {
                configurable: true,
                get() { const t = Object.create(namedNodeMapProto); t._el = this; return new Proxy(t, handler); },
            });
            if (typeof globalThis.NamedNodeMap === "undefined") { globalThis.NamedNodeMap = function NamedNodeMap() { throw new TypeError("Illegal constructor"); }; globalThis.NamedNodeMap.prototype = namedNodeMapProto; }
            defineIfMissing(e, "removeAttributeNode", function (attr) { this.removeAttribute(attr.name); return attr; });
        }

        // 属性反映プロパティ
        const reflectString = (prop, attr = prop.toLowerCase()) => accessorIfMissing(e, prop, function () { return this.getAttribute(attr) ?? ""; }, function (v) { this.setAttribute(attr, String(v)); });
        const reflectUrl = (prop, attr = prop.toLowerCase()) => accessorIfMissing(e, prop, function () { const v = this.getAttribute(attr); if (v === null) return ""; try { return new URL(v, document.baseURI).href; } catch (err) { return v; } }, function (v) { this.setAttribute(attr, String(v)); });
        const reflectBool = (prop, attr = prop.toLowerCase()) => accessorIfMissing(e, prop, function () { return this.hasAttribute(attr); }, function (v) { this.toggleAttribute(attr, !!v); });
        const reflectNumber = (prop, attr = prop.toLowerCase(), def = 0) => accessorIfMissing(e, prop, function () { const v = parseFloat(this.getAttribute(attr)); return isNaN(v) ? def : v; }, function (v) { this.setAttribute(attr, String(v)); });
        for (const p of ["title", "lang", "dir", "role", "rel", "target", "download", "hreflang", "alt", "srcset", "sizes", "media", "charset", "content", "integrity", "label", "wrap", "accept", "pattern", "min", "max", "step", "list", "dirName", "align", "valign", "abbr", "scope", "headers", "cite", "dateTime", "coords", "shape", "usemap", "useMap", "ping", "kind", "srclang", "sandbox", "allow", "scrolling", "frameBorder", "marginWidth", "marginHeight", "bgColor", "color", "face", "border", "cellPadding", "cellSpacing", "summary", "rules", "frame", "axis", "ch", "chOff", "vAlign", "event", "autocapitalize", "autocomplete", "enctype", "method", "acceptCharset", "elementTiming", "fetchPriority", "referrerPolicy", "crossOrigin", "decoding", "loading", "preload", "as", "imageSrcset", "imageSizes", "blocking", "httpEquiv", "scheme", "version", "vlink", "link", "alink", "text", "background", "clear", "noWrap", "compact", "type", "name", "value", "placeholder"]) {
            const attr = { dirName: "dirname", dateTime: "datetime", useMap: "usemap", frameBorder: "frameborder", marginWidth: "marginwidth", marginHeight: "marginheight", bgColor: "bgcolor", cellPadding: "cellpadding", cellSpacing: "cellspacing", chOff: "choff", vAlign: "valign", acceptCharset: "accept-charset", fetchPriority: "fetchpriority", referrerPolicy: "referrerpolicy", crossOrigin: "crossorigin", imageSrcset: "imagesrcset", imageSizes: "imagesizes", httpEquiv: "http-equiv", noWrap: "nowrap" }[p] ?? p.toLowerCase();
            reflectString(p, attr);
        }
        for (const p of ["src", "href", "action", "poster", "cite", "data", "formAction", "longDesc", "codeBase"]) reflectUrl(p, { formAction: "formaction", longDesc: "longdesc", codeBase: "codebase" }[p] ?? p);
        for (const p of ["async", "defer", "noModule", "required", "readOnly", "multiple", "checked", "selected", "open", "controls", "autoplay", "loop", "muted", "playsInline", "default", "disabled", "noValidate", "formNoValidate", "reversed", "isMap", "allowFullscreen", "ismap", "indeterminate", "defaultChecked", "defaultSelected", "declare", "noHref", "noShade", "noResize", "compact", "autofocus", "hidden"]) {
            const attr = { noModule: "nomodule", readOnly: "readonly", playsInline: "playsinline", noValidate: "novalidate", formNoValidate: "formnovalidate", isMap: "ismap", allowFullscreen: "allowfullscreen", defaultChecked: "checked", defaultSelected: "selected", noHref: "nohref", noShade: "noshade", noResize: "noresize" }[p] ?? p.toLowerCase();
            reflectBool(p, attr);
        }
        reflectNumber("colSpan", "colspan", 1); reflectNumber("rowSpan", "rowspan", 1); reflectNumber("span", "span", 1); reflectNumber("start", "start", 1); reflectNumber("cols", "cols", 20); reflectNumber("rows", "rows", 2); reflectNumber("size", "size", 20); reflectNumber("maxLength", "maxlength", -1); reflectNumber("minLength", "minlength", -1); reflectNumber("width", "width", 0); reflectNumber("height", "height", 0); reflectNumber("hspace", "hspace", 0); reflectNumber("vspace", "vspace", 0); reflectNumber("tabIndex", "tabindex", -1);
        reflectString("slot");
        accessorIfMissing(e, "htmlFor", function () { return this.getAttribute("for") ?? ""; }, function (v) { this.setAttribute("for", String(v)); });
        accessorIfMissing(e, "relList", function () { const el = this; return tokenList(el, "rel"); });
        accessorIfMissing(e, "sandbox", function () { return tokenList(this, "sandbox"); });
        accessorIfMissing(e, "htmlFor", function () { return this.getAttribute("for") ?? ""; }, function (v) { this.setAttribute("for", String(v)); });
        const tokenList = (el, attr) => {
            const tokens = () => (el.getAttribute(attr) || "").split(/\s+/).filter(Boolean);
            const write = (list) => el.setAttribute(attr, list.join(" "));
            return { get length() { return tokens().length; }, get value() { return el.getAttribute(attr) ?? ""; }, set value(v) { el.setAttribute(attr, String(v)); }, item: (i) => tokens()[i] ?? null, contains: (t) => tokens().includes(String(t)), add(...ts) { const l = tokens(); for (const t of ts) if (!l.includes(String(t))) l.push(String(t)); write(l); }, remove(...ts) { write(tokens().filter((t) => !ts.map(String).includes(t))); }, toggle(t, force) { const has = tokens().includes(String(t)); if (force === undefined ? has : !force) { this.remove(t); return false; } this.add(t); return true; }, replace(a, b) { const l = tokens(); const i = l.indexOf(String(a)); if (i < 0) return false; l[i] = String(b); write(l); return true; }, supports: () => true, forEach(cb, thisArg) { tokens().forEach((t, i) => cb.call(thisArg, t, i, this)); }, entries: () => tokens().entries(), keys: () => tokens().keys(), values: () => tokens().values(), [Symbol.iterator]: () => tokens()[Symbol.iterator](), toString: () => el.getAttribute(attr) ?? "" };
        };
        // ARIA 反映プロパティ
        for (const aria of ["atomic", "autocomplete", "busy", "checked", "colcount", "colindex", "colspan", "current", "description", "disabled", "expanded", "haspopup", "hidden", "invalid", "keyshortcuts", "label", "level", "live", "modal", "multiline", "multiselectable", "orientation", "placeholder", "posinset", "pressed", "readonly", "relevant", "required", "roledescription", "rowcount", "rowindex", "rowspan", "selected", "setsize", "sort", "valuemax", "valuemin", "valuenow", "valuetext", "braillelabel", "brailleroledescription"]) {
            const prop = "aria" + aria[0].toUpperCase() + aria.slice(1);
            accessorIfMissing(e, prop, function () { return this.getAttribute("aria-" + aria); }, function (v) { if (v === null) this.removeAttribute("aria-" + aria); else this.setAttribute("aria-" + aria, String(v)); });
        }
        // 画像・メディア・フォーム・その他のタグ固有プロパティ(全要素に薄く載せる)
        accessorIfMissing(e, "complete", () => true);
        accessorIfMissing(e, "currentSrc", function () { return this.src ?? ""; });
        accessorIfMissing(e, "naturalWidth", function () { return this.getBoundingClientRect().width | 0; });
        accessorIfMissing(e, "naturalHeight", function () { return this.getBoundingClientRect().height | 0; });
        defineIfMissing(e, "decode", () => Promise.resolve());
        defineIfMissing(e, "play", () => Promise.resolve());
        defineIfMissing(e, "pause", () => {});
        defineIfMissing(e, "load", () => {});
        defineIfMissing(e, "canPlayType", () => "");
        accessorIfMissing(e, "paused", () => true);
        accessorIfMissing(e, "ended", () => false);
        accessorIfMissing(e, "seeking", () => false);
        accessorIfMissing(e, "readyState", () => 0);
        accessorIfMissing(e, "networkState", () => 0);
        accessorIfMissing(e, "duration", () => NaN);
        accessorIfMissing(e, "currentTime", () => 0, () => {});
        accessorIfMissing(e, "volume", () => 1, () => {});
        accessorIfMissing(e, "playbackRate", () => 1, () => {});
        accessorIfMissing(e, "videoWidth", () => 0);
        accessorIfMissing(e, "videoHeight", () => 0);
        accessorIfMissing(e, "buffered", () => ({ length: 0, start: () => 0, end: () => 0 }));
        accessorIfMissing(e, "played", () => ({ length: 0, start: () => 0, end: () => 0 }));
        accessorIfMissing(e, "seekable", () => ({ length: 0, start: () => 0, end: () => 0 }));
        accessorIfMissing(e, "textTracks", () => Object.assign([], { onaddtrack: null, addEventListener() {}, removeEventListener() {} }));
        accessorIfMissing(e, "error", () => null);
        defineIfMissing(e, "addTextTrack", () => ({ mode: "hidden", cues: [], addCue() {}, removeCue() {} }));
        defineIfMissing(e, "requestPictureInPicture", () => Promise.reject(new DOMException("not supported", "NotSupportedError")));
        defineIfMissing(e, "captureStream", () => null);
        defineIfMissing(e, "getContext", () => null);
        defineIfMissing(e, "toDataURL", () => "data:,");
        defineIfMissing(e, "toBlob", (cb) => { setTimeout(() => cb(null), 0); });
        defineIfMissing(e, "transferControlToOffscreen", () => { throw new DOMException("not supported", "NotSupportedError"); });
        // iframe: src の無い同一オリジンの空フレームは、実ブラウザと同じく自分と同じグローバルを見せる
        // (castle などが「汚されていない Date」を取るために隠し iframe を作る)。
        // src 付きは別オリジン扱いで、postMessage だけ通る制限付きウィンドウを返す。
        const blankFrameDocs = new WeakMap();
        const isBlankFrame = (el) => {
            if (el.localName !== "iframe") return false;
            if (el.hasAttribute("srcdoc")) return true;
            const src = (el.getAttribute("src") || "").trim();
            return src === "" || src.startsWith("about:blank") || src.startsWith("javascript:");
        };
        const restrictedWindow = (el) => {
            const w = {
                postMessage() {}, focus() {}, blur() {}, close() {}, closed: false, length: 0,
                get parent() { return window; }, get top() { return window.top; }, get self() { return w; }, get window() { return w; },
                get frames() { return w; }, get opener() { return null; },
                get location() { return { replace() {}, assign() {}, reload() {}, set href(v) {}, toString() { return ""; } }; },
            };
            return w;
        };
        accessorIfMissing(e, "contentWindow", function () {
            if (this.localName !== "iframe" || !this.isConnected) return null;
            return isBlankFrame(this) ? window : restrictedWindow(this);
        });
        accessorIfMissing(e, "contentDocument", function () {
            if (this.localName !== "iframe" || !this.isConnected || !isBlankFrame(this)) return null;
            let doc = blankFrameDocs.get(this);
            if (!doc) {
                doc = document.implementation.createHTMLDocument("");
                if (this.hasAttribute("srcdoc")) { try { doc.documentElement.innerHTML = this.getAttribute("srcdoc"); } catch {} }
                blankFrameDocs.set(this, doc);
            }
            return doc;
        });
        defineIfMissing(e, "getSVGDocument", () => null);
        accessorIfMissing(e, "form", function () { return this.closest("form"); });
        accessorIfMissing(e, "labels", function () { const id = this.getAttribute("id"); return id ? Array.from(document.querySelectorAll(`label[for="${id}"]`)) : []; });
        accessorIfMissing(e, "control", function () { const f = this.getAttribute("for"); return f ? document.getElementById(f) : this.querySelector("input, select, textarea, button"); });
        accessorIfMissing(e, "files", () => null, () => {});
        accessorIfMissing(e, "valueAsNumber", function () { const v = parseFloat(this.value); return isNaN(v) ? NaN : v; }, function (v) { this.value = String(v); });
        accessorIfMissing(e, "valueAsDate", function () { const d = new Date(this.value); return isNaN(d) ? null : d; }, function (v) { this.value = v ? new Date(v).toISOString().slice(0, 10) : ""; });
        accessorIfMissing(e, "defaultValue", function () { return this.getAttribute("value") ?? ""; }, function (v) { this.setAttribute("value", String(v)); });
        accessorIfMissing(e, "validity", () => ({ valid: true, valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: false }));
        accessorIfMissing(e, "validationMessage", () => "");
        accessorIfMissing(e, "willValidate", () => true);
        defineIfMissing(e, "checkValidity", () => true);
        defineIfMissing(e, "reportValidity", () => true);
        defineIfMissing(e, "setCustomValidity", () => {});
        defineIfMissing(e, "stepUp", () => {});
        defineIfMissing(e, "stepDown", () => {});
        defineIfMissing(e, "showPicker", () => {});
        defineIfMissing(e, "select", function () { if (typeof this.setSelectionRange === "function") try { this.setSelectionRange(0, String(this.value ?? "").length); } catch (err) {} });
        accessorIfMissing(e, "selectionDirection", () => "none", () => {});
        accessorIfMissing(e, "textLength", function () { return String(this.value ?? "").length; });
        accessorIfMissing(e, "options", function () { return Array.from(this.querySelectorAll("option")); });
        accessorIfMissing(e, "selectedOptions", function () { return Array.from(this.querySelectorAll("option")).filter((o) => o.selected); });
        accessorIfMissing(e, "selectedIndex", function () { const os = Array.from(this.querySelectorAll("option")); const i = os.findIndex((o) => o.hasAttribute("selected")); return i >= 0 ? i : (os.length ? 0 : -1); }, function (i) { const os = Array.from(this.querySelectorAll("option")); os.forEach((o, j) => o.toggleAttribute("selected", j === Number(i))); });
        accessorIfMissing(e, "length", function () { return this.querySelectorAll("option").length; });
        defineIfMissing(e, "item", function (i) { return this.querySelectorAll("option")[i] ?? null; });
        defineIfMissing(e, "namedItem", function (n) { return this.querySelector(`option[name="${n}"], option[id="${n}"]`); });
        defineIfMissing(e, "add", function (o, before) { this.insertBefore(o, before ?? null); });
        accessorIfMissing(e, "index", function () { return Array.from(this.parentNode ? this.parentNode.querySelectorAll("option") : []).indexOf(this); });
        const withNamedItem = (arr) => Object.assign(arr, {
            item(i) { return arr[i] ?? null; },
            namedItem(n) { n = String(n); const hits = arr.filter((el) => el.getAttribute("name") === n || el.id === n); return hits.length === 0 ? null : hits.length === 1 ? hits[0] : withNamedItem(hits); },
        });
        accessorIfMissing(e, "elements", function () { return withNamedItem(Array.from(this.querySelectorAll("input, select, textarea, button, fieldset, output, object"))); });
        defineIfMissing(e, "reset", function () { for (const el of this.querySelectorAll("input, textarea, select")) { if ("defaultValue" in el) el.value = el.defaultValue; } this.dispatchEvent(new Event("reset", { bubbles: true })); });
        defineIfMissing(e, "showModal", function () { this.setAttribute("open", ""); });
        defineIfMissing(e, "show", function () { this.setAttribute("open", ""); });
        defineIfMissing(e, "close", function (v) { this.removeAttribute("open"); if (v !== undefined) this.returnValue = v; this.dispatchEvent(new Event("close")); });
        accessorIfMissing(e, "returnValue", function () { return this._returnValue ?? ""; }, function (v) { this._returnValue = String(v); });
        defineIfMissing(e, "getBBox", function () { const r = this.getBoundingClientRect(); return { x: 0, y: 0, width: r.width, height: r.height }; });
        defineIfMissing(e, "getCTM", () => null);
        defineIfMissing(e, "getScreenCTM", () => null);
        defineIfMissing(e, "createSVGPoint", () => ({ x: 0, y: 0, matrixTransform() { return this; } }));
        accessorIfMissing(e, "ownerSVGElement", function () { return this.closest("svg"); });
        accessorIfMissing(e, "viewBox", function () { const v = (this.getAttribute("viewBox") || "0 0 0 0").split(/[\s,]+/).map(Number); return { baseVal: { x: v[0], y: v[1], width: v[2], height: v[3] }, animVal: { x: v[0], y: v[1], width: v[2], height: v[3] } }; });
        defineIfMissing(e, "getTotalLength", () => 0);
        defineIfMissing(e, "getPointAtLength", () => ({ x: 0, y: 0 }));
        defineIfMissing(e, "getComputedTextLength", () => 0);
        accessorIfMissing(e, "origin", function () { try { return new URL(this.href).origin; } catch (err) { return ""; } });
        for (const [prop, part] of [["protocol", "protocol"], ["host", "host"], ["hostname", "hostname"], ["port", "port"], ["pathname", "pathname"], ["search", "search"], ["hash", "hash"], ["username", "username"], ["password", "password"]]) {
            accessorIfMissing(e, prop, function () { try { return new URL(this.href)[part]; } catch (err) { return ""; } }, function (v) { try { const u = new URL(this.href); u[part] = String(v); this.href = u.href; } catch (err) {} });
        }
        defineIfMissing(e, "toString", function () { return this.href !== undefined && this.localName === "a" ? this.href : "[object HTMLElement]"; });

        // Text
        const t = charDataProto;
        defineIfMissing(t, "splitText", function (offset) { const rest = this.data.slice(offset); this.data = this.data.slice(0, offset); const node = document.createTextNode(rest); if (this.parentNode) this.parentNode.insertBefore(node, this.nextSibling); return node; });
        accessorIfMissing(t, "wholeText", function () { let s = this; while (s.previousSibling && s.previousSibling.nodeType === 3) s = s.previousSibling; let out = ""; while (s && s.nodeType === 3) { out += s.data; s = s.nextSibling; } return out; });
        accessorIfMissing(t, "length", function () { return this.data.length; });
        defineIfMissing(t, "substringData", function (o, c) { return this.data.substr(o, c); });
        defineIfMissing(t, "appendData", function (d) { this.data += d; });
        defineIfMissing(t, "insertData", function (o, d) { this.data = this.data.slice(0, o) + d + this.data.slice(o); });
        defineIfMissing(t, "deleteData", function (o, c) { this.data = this.data.slice(0, o) + this.data.slice(o + c); });
        defineIfMissing(t, "replaceData", function (o, c, d) { this.data = this.data.slice(0, o) + d + this.data.slice(o + c); });
        defineIfMissing(t, "remove", function () { if (this.parentNode) this.parentNode.removeChild(this); });
        accessorIfMissing(t, "assignedSlot", () => null);

        // コレクション系のインターフェースオブジェクト
        // タグ固有インターフェース: 全要素が同じプロトタイプを共有するため、instanceof はタグ名で判定する
        const tagInterfaces = {
            HTMLInputElement: ["input"], HTMLTextAreaElement: ["textarea"], HTMLSelectElement: ["select"], HTMLButtonElement: ["button"],
            HTMLAnchorElement: ["a"], HTMLIFrameElement: ["iframe"], HTMLImageElement: ["img"], HTMLFormElement: ["form"], HTMLDivElement: ["div"],
            HTMLSpanElement: ["span"], HTMLVideoElement: ["video"], HTMLAudioElement: ["audio"], HTMLMediaElement: ["video", "audio"], HTMLCanvasElement: ["canvas"],
            HTMLScriptElement: ["script"], HTMLStyleElement: ["style"], HTMLLinkElement: ["link"], HTMLMetaElement: ["meta"], HTMLBodyElement: ["body"], HTMLHtmlElement: ["html"],
            HTMLHeadElement: ["head"], HTMLLabelElement: ["label"], HTMLOptionElement: ["option"], HTMLParagraphElement: ["p"], HTMLUListElement: ["ul"], HTMLOListElement: ["ol"],
            HTMLLIElement: ["li"], HTMLTableElement: ["table"], HTMLTemplateElement: ["template"], HTMLDialogElement: ["dialog"], HTMLDetailsElement: ["details"], HTMLSlotElement: ["slot"],
            HTMLPictureElement: ["picture"], HTMLSourceElement: ["source"], HTMLTrackElement: ["track"], HTMLEmbedElement: ["embed"], HTMLObjectElement: ["object"], HTMLProgressElement: ["progress"],
            HTMLFieldSetElement: ["fieldset"], HTMLOutputElement: ["output"], HTMLHeadingElement: ["h1", "h2", "h3", "h4", "h5", "h6"], HTMLBRElement: ["br"], HTMLHRElement: ["hr"], HTMLPreElement: ["pre"],
            HTMLQuoteElement: ["blockquote", "q"], HTMLTimeElement: ["time"], HTMLDataElement: ["data"], HTMLAreaElement: ["area"], HTMLMapElement: ["map"], HTMLBaseElement: ["base"], HTMLTitleElement: ["title"],
            HTMLModElement: ["ins", "del"], HTMLDListElement: ["dl"], HTMLMenuElement: ["menu"], HTMLTableRowElement: ["tr"], HTMLTableCellElement: ["td", "th"], HTMLTableSectionElement: ["thead", "tbody", "tfoot"],
            HTMLTableColElement: ["col", "colgroup"], HTMLTableCaptionElement: ["caption"], HTMLLegendElement: ["legend"], HTMLOptGroupElement: ["optgroup"], HTMLDataListElement: ["datalist"], HTMLMeterElement: ["meter"],
            SVGSVGElement: ["svg"], SVGGElement: ["g"], SVGPathElement: ["path"], SVGUseElement: ["use"], SVGCircleElement: ["circle"], SVGRectElement: ["rect"], SVGImageElement: ["image"], SVGTextElement: ["text"],
            SVGLineElement: ["line"], SVGPolygonElement: ["polygon"], SVGPolylineElement: ["polyline"], SVGEllipseElement: ["ellipse"], SVGDefsElement: ["defs"], SVGSymbolElement: ["symbol"], SVGLinearGradientElement: ["linearGradient"],
            SVGStopElement: ["stop"], SVGClipPathElement: ["clipPath"], SVGMaskElement: ["mask"], SVGForeignObjectElement: ["foreignObject"], SVGTitleElement: ["title"], SVGStyleElement: ["style"],
        };
        const SVG_NS = "http://www.w3.org/2000/svg";
        // instanceof を使うと hasInstance が再帰するので、プロトタイプ連鎖で判定する
        const isElement = (x) => x !== null && typeof x === "object" && elementProto.isPrototypeOf(x);
        const installHasInstance = (name, tags) => {
            const isSvg = name.startsWith("SVG");
            const test = (x) => isElement(x) && tags.includes(x.localName) && ((x.namespaceURI === SVG_NS) === isSvg);
            if (typeof globalThis[name] === "undefined") { const f = function () { throw new TypeError("Illegal constructor"); }; Object.defineProperty(f, "name", { value: name }); f.prototype = elementProto; globalThis[name] = f; }
            Object.defineProperty(globalThis[name], Symbol.hasInstance, { value: test, configurable: true });
        };
        for (const [name, tags] of Object.entries(tagInterfaces)) installHasInstance(name, tags);
        Object.defineProperty(globalThis.SVGElement, Symbol.hasInstance, { value: (x) => isElement(x) && x.namespaceURI === SVG_NS, configurable: true });
        // HTMLElement は Element と別のインターフェースオブジェクトにする(上流は同一にしている)
        if (globalThis.HTMLElement === globalThis.Element) {
            const f = function HTMLElement() { throw new TypeError("Illegal constructor"); };
            f.prototype = elementProto;
            globalThis.HTMLElement = f;
        }
        Object.defineProperty(globalThis.HTMLElement, Symbol.hasInstance, { value: (x) => isElement(x) && x.namespaceURI !== SVG_NS, configurable: true });
        globalThis.SVGGraphicsElement = globalThis.SVGElement;
        globalThis.HTMLUnknownElement = globalThis.HTMLElement;

        const nodeListProto = Object.getPrototypeOf(document.querySelectorAll("html"));
        const iface = (name, proto) => { if (typeof globalThis[name] !== "undefined") return; const f = function () { throw new TypeError("Illegal constructor"); }; Object.defineProperty(f, "name", { value: name }); f.prototype = proto; globalThis[name] = f; };
        iface("NodeList", nodeListProto);
        iface("HTMLCollection", Object.getPrototypeOf(document.getElementsByTagName("html")));
        iface("DOMTokenList", Object.getPrototypeOf(document.documentElement.classList));
        iface("ShadowRoot", Object.create(fragmentProto));
        iface("Attr", {});
        iface("CSSStyleDeclaration", Object.getPrototypeOf(document.documentElement.style));
        iface("Text", charDataProto); iface("Comment", charDataProto); iface("CharacterData", charDataProto); iface("ProcessingInstruction", charDataProto); iface("CDATASection", charDataProto);
        iface("DocumentFragment", fragmentProto);
        iface("DocumentType", {});
        iface("XMLDocument", documentProto);
        iface("MediaList", {}); iface("StyleSheet", {}); iface("CSSStyleSheet", {});
        if (typeof globalThis.DOMStringList === "undefined") globalThis.DOMStringList = Array;
        if (typeof globalThis.DataTransfer === "undefined") {
            class DataTransferItemList { constructor() { this._items = []; } get length() { return this._items.length; } add(data, type) { const item = { kind: typeof data === "string" ? "string" : "file", type: type ?? (data && data.type) ?? "", getAsString: (cb) => cb(String(data)), getAsFile: () => (data instanceof Blob ? data : null) }; this._items.push(item); return item; } remove(i) { this._items.splice(i, 1); } clear() { this._items = []; } [Symbol.iterator]() { return this._items[Symbol.iterator](); } }
            class DataTransfer { constructor() { this.dropEffect = "none"; this.effectAllowed = "uninitialized"; this.items = new DataTransferItemList(); this.files = []; this._data = new Map(); } get types() { return [...this._data.keys()]; } setData(t, v) { this._data.set(String(t), String(v)); } getData(t) { return this._data.get(String(t)) ?? ""; } clearData(t) { if (t === undefined) this._data.clear(); else this._data.delete(String(t)); } setDragImage() {} }
            globalThis.DataTransfer = DataTransfer;
            globalThis.DataTransferItemList = DataTransferItemList;
        }
        if (typeof globalThis.Worker === "undefined") {
            // Worker は提供しない(`typeof Worker === "undefined"` で判定させる)。
        }
        if (typeof globalThis.Notification === "undefined") {
            // 通知も提供しない。
        }
    }

    // =========================================================================
    // CSSStyleDeclaration の補助
    // =========================================================================
    {
        const styleProto = Object.getPrototypeOf(document.documentElement.style);
        defineIfMissing(styleProto, "getPropertyPriority", () => "");
        accessorIfMissing(styleProto, "length", function () { return (this.cssText || "").split(";").filter((s) => s.trim()).length; });
        defineIfMissing(styleProto, "item", function (i) { const decl = (this.cssText || "").split(";").map((s) => s.split(":")[0].trim()).filter(Boolean); return decl[i] ?? ""; });
        accessorIfMissing(styleProto, "parentRule", () => null);
    }

    // =========================================================================
    // 未処理の Promise 拒否をログに出す(Boa は既定で黙って捨てる)
    // =========================================================================
    globalThis.__sunameri_polyfills_loaded = true;
})();
