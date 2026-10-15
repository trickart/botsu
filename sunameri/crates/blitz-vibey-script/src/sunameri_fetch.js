// sunameri 拡張: 非同期 fetch / Request / Response / Headers / XMLHttpRequest / Blob / FormData
//
// `__blitz_fetch_async(url, method, headers, body, followRedirects)` が返す
// `[status, statusText, url, headers, Uint8Array, redirected]` を Fetch API の形に包む。
(function () {
    "use strict";
    if (typeof __blitz_fetch_async !== "function") return;

    const Headers = globalThis.Headers;
    const utf8Encoder = new TextEncoder();
    const utf8Decoder = new TextDecoder();

    // ---- AbortController / AbortSignal --------------------------------------
    class AbortSignal {
        #aborted = false;
        #reason = undefined;
        #listeners = [];
        onabort = null;
        get aborted() { return this.#aborted; }
        get reason() { return this.#reason; }
        throwIfAborted() { if (this.#aborted) throw this.#reason; }
        addEventListener(type, cb) { if (type === "abort" && typeof cb === "function") this.#listeners.push(cb); }
        removeEventListener(type, cb) { if (type === "abort") this.#listeners = this.#listeners.filter((l) => l !== cb); }
        dispatchEvent(ev) { for (const l of this.#listeners.slice()) l.call(this, ev); if (typeof this.onabort === "function") this.onabort(ev); return true; }
        _abort(reason) {
            if (this.#aborted) return;
            this.#aborted = true;
            this.#reason = reason === undefined ? new DOMException("signal is aborted without reason", "AbortError") : reason;
            this.dispatchEvent({ type: "abort", target: this, currentTarget: this });
        }
        static abort(reason) { const s = new AbortSignal(); s._abort(reason); return s; }
        static timeout(ms) { const s = new AbortSignal(); setTimeout(() => s._abort(new DOMException("signal timed out", "TimeoutError")), ms); return s; }
        static any(signals) { const s = new AbortSignal(); for (const x of signals) { if (x.aborted) { s._abort(x.reason); break; } x.addEventListener("abort", () => s._abort(x.reason)); } return s; }
    }
    class AbortController {
        #signal = new AbortSignal();
        get signal() { return this.#signal; }
        abort(reason) { this.#signal._abort(reason); }
    }
    globalThis.AbortSignal = AbortSignal;
    globalThis.AbortController = AbortController;

    // ---- Blob / File ----------------------------------------------------------
    const toUint8 = (part) => {
        if (part instanceof Uint8Array) return part;
        if (part instanceof ArrayBuffer) return new Uint8Array(part);
        if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
        if (part instanceof Blob) return part._bytes();
        return utf8Encoder.encode(String(part));
    };
    const concat = (chunks) => {
        let total = 0;
        for (const c of chunks) total += c.byteLength;
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.byteLength; }
        return out;
    };
    class Blob {
        #bytes;
        #type;
        constructor(parts = [], options = {}) {
            this.#bytes = concat(Array.from(parts, toUint8));
            this.#type = String(options.type ?? "").toLowerCase();
        }
        _bytes() { return this.#bytes; }
        get size() { return this.#bytes.byteLength; }
        get type() { return this.#type; }
        slice(start = 0, end = this.size, type = "") {
            const b = new Blob([], { type });
            b.#bytes = this.#bytes.slice(start, end);
            return b;
        }
        text() { return Promise.resolve(utf8Decoder.decode(this.#bytes)); }
        arrayBuffer() { return Promise.resolve(this.#bytes.slice().buffer); }
        bytes() { return Promise.resolve(this.#bytes.slice()); }
        stream() { const bytes = this.#bytes; return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }); }
        get [Symbol.toStringTag]() { return "Blob"; }
    }
    class File extends Blob {
        #name; #lastModified;
        constructor(parts, name, options = {}) {
            super(parts, options);
            this.#name = String(name);
            this.#lastModified = options.lastModified ?? Date.now();
        }
        get name() { return this.#name; }
        get lastModified() { return this.#lastModified; }
        get webkitRelativePath() { return ""; }
        get [Symbol.toStringTag]() { return "File"; }
    }
    globalThis.Blob = Blob;
    globalThis.File = File;

    // ---- Streams(ReadableStream / WritableStream / TransformStream)------------
    // 非同期に enqueue/close されるストリームを扱える最小実装。
    class ReadableStream {
        constructor(source = {}, strategy) {
            this._queue = []; this._closed = false; this._errored = null; this._pendingReads = []; this._locked = false; this._pulling = false;
            this._source = source;
            const self = this;
            this._controller = {
                get desiredSize() { return self._closed ? null : 1; },
                enqueue(chunk) { if (self._closed) throw new TypeError("Cannot enqueue a chunk into a closed stream"); if (self._pendingReads.length) self._pendingReads.shift().resolve({ value: chunk, done: false }); else self._queue.push(chunk); },
                close() { if (self._closed) return; self._closed = true; while (self._pendingReads.length) self._pendingReads.shift().resolve({ value: undefined, done: true }); self._resolveClosed(); },
                error(e) { if (self._closed) return; self._closed = true; self._errored = e === undefined ? new TypeError("stream errored") : e; while (self._pendingReads.length) self._pendingReads.shift().reject(self._errored); self._rejectClosed(self._errored); },
                byobRequest: null,
            };
            this._closedPromise = new Promise((res, rej) => { this._resolveClosed = res; this._rejectClosed = rej; });
            this._closedPromise.catch(() => {});
            // 仕様どおり start() は同期的に呼ぶ(戻り値の Promise だけを待つ)
            let startResult;
            try { startResult = typeof source.start === "function" ? source.start(this._controller) : undefined; }
            catch (e) { this._controller.error(e); startResult = undefined; }
            this._started = Promise.resolve(startResult).catch((e) => this._controller.error(e));
        }
        _pull() {
            if (this._pulling || this._closed || typeof this._source.pull !== "function") return;
            this._pulling = true;
            this._started.then(() => this._source.pull(this._controller)).then(() => { this._pulling = false; if (this._pendingReads.length && !this._closed) this._pull(); }, (e) => { this._pulling = false; this._controller.error(e); });
        }
        get locked() { return this._locked; }
        getReader(opts) {
            if (this._locked) throw new TypeError("ReadableStream is locked");
            this._locked = true;
            const s = this;
            return {
                read() {
                    if (s._errored) return Promise.reject(s._errored);
                    if (s._queue.length) return Promise.resolve({ value: s._queue.shift(), done: false });
                    if (s._closed) return Promise.resolve({ value: undefined, done: true });
                    return new Promise((resolve, reject) => { s._pendingReads.push({ resolve, reject }); s._pull(); });
                },
                releaseLock() { s._locked = false; },
                cancel(reason) { s._locked = false; return s.cancel(reason); },
                get closed() { return s._closedPromise; },
            };
        }
        cancel(reason) {
            this._queue = [];
            if (!this._closed) { this._closed = true; while (this._pendingReads.length) this._pendingReads.shift().resolve({ value: undefined, done: true }); this._resolveClosed(); }
            try { if (typeof this._source.cancel === "function") return Promise.resolve(this._source.cancel(reason)).then(() => undefined); } catch (e) { return Promise.reject(e); }
            return Promise.resolve();
        }
        tee() {
            const a = new ReadableStream(), b = new ReadableStream();
            const reader = this.getReader();
            const pump = () => reader.read().then(({ value, done }) => { if (done) { a._controller.close(); b._controller.close(); return; } a._controller.enqueue(value); b._controller.enqueue(value); return pump(); }, (e) => { a._controller.error(e); b._controller.error(e); });
            pump();
            return [a, b];
        }
        pipeTo(dest, opts) {
            const reader = this.getReader();
            const writer = dest.getWriter();
            const pump = () => reader.read().then(({ value, done }) => (done ? writer.close() : writer.write(value).then(pump)));
            return pump().catch((e) => { try { writer.abort(e); } catch (_) {} throw e; });
        }
        pipeThrough(t, opts) { this.pipeTo(t.writable, opts).catch(() => {}); return t.readable; }
        values() { const r = this.getReader(); return { next: () => r.read(), return: () => { r.releaseLock(); return Promise.resolve({ value: undefined, done: true }); }, [Symbol.asyncIterator]() { return this; } }; }
        [Symbol.asyncIterator]() { return this.values(); }
        static from(iterable) { return new ReadableStream({ async start(c) { for await (const x of iterable) c.enqueue(x); c.close(); } }); }
        _bytes() { return concat(this._queue.map(toUint8)); }
        get [Symbol.toStringTag]() { return "ReadableStream"; }
    }
    class WritableStream {
        constructor(sink = {}, strategy) {
            this._sink = sink; this._locked = false; this._closed = false;
            const self = this;
            this._controller = { error(e) { self._closed = true; self._error = e; }, get signal() { return new AbortSignal(); } };
            let startResult;
            try { startResult = typeof sink.start === "function" ? sink.start(this._controller) : undefined; } catch (e) { startResult = Promise.reject(e); }
            this._started = Promise.resolve(startResult);
            this._chain = this._started;
        }
        get locked() { return this._locked; }
        getWriter() {
            if (this._locked) throw new TypeError("WritableStream is locked");
            this._locked = true;
            const s = this;
            return {
                get ready() { return s._chain.then(() => undefined); },
                get closed() { return s._chain.then(() => undefined); },
                get desiredSize() { return 1; },
                write(chunk) { s._chain = s._chain.then(() => (typeof s._sink.write === "function" ? s._sink.write(chunk, s._controller) : undefined)); return s._chain; },
                close() { s._closed = true; s._chain = s._chain.then(() => (typeof s._sink.close === "function" ? s._sink.close() : undefined)); return s._chain; },
                abort(r) { s._closed = true; return Promise.resolve(typeof s._sink.abort === "function" ? s._sink.abort(r) : undefined); },
                releaseLock() { s._locked = false; },
            };
        }
        abort(r) { return this.getWriter().abort(r); }
        close() { return this.getWriter().close(); }
        get [Symbol.toStringTag]() { return "WritableStream"; }
    }
    class TransformStream {
        constructor(transformer = {}, ws, rs) {
            let readableCtrl;
            this.readable = new ReadableStream({ start(c) { readableCtrl = c; } });
            const controller = { enqueue: (c) => readableCtrl.enqueue(c), terminate: () => readableCtrl.close(), error: (e) => readableCtrl.error(e), get desiredSize() { return 1; } };
            this.writable = new WritableStream({
                start: () => (typeof transformer.start === "function" ? transformer.start(controller) : undefined),
                write: (chunk) => (typeof transformer.transform === "function" ? transformer.transform(chunk, controller) : controller.enqueue(chunk)),
                close: () => Promise.resolve(typeof transformer.flush === "function" ? transformer.flush(controller) : undefined).then(() => readableCtrl.close()),
                abort: (e) => readableCtrl.error(e),
            });
        }
        get [Symbol.toStringTag]() { return "TransformStream"; }
    }
    class TextDecoderStream extends TransformStream {
        constructor(label = "utf-8", options) { const dec = new TextDecoder(label, options); super({ transform(chunk, c) { c.enqueue(dec.decode(toUint8(chunk), { stream: true })); }, flush(c) { const t = dec.decode(); if (t) c.enqueue(t); } }); this.encoding = dec.encoding; }
    }
    class TextEncoderStream extends TransformStream {
        constructor() { super({ transform(chunk, c) { c.enqueue(utf8Encoder.encode(String(chunk))); } }); this.encoding = "utf-8"; }
    }
    globalThis.ReadableStream = ReadableStream;
    globalThis.WritableStream = WritableStream;
    globalThis.TransformStream = TransformStream;
    globalThis.TextDecoderStream = TextDecoderStream;
    globalThis.TextEncoderStream = TextEncoderStream;
    globalThis.ReadableStreamDefaultReader = function ReadableStreamDefaultReader() { throw new TypeError("Illegal constructor"); };
    globalThis.CountQueuingStrategy = class CountQueuingStrategy { constructor(i) { this.highWaterMark = i.highWaterMark; } size() { return 1; } };
    globalThis.ByteLengthQueuingStrategy = class ByteLengthQueuingStrategy { constructor(i) { this.highWaterMark = i.highWaterMark; } size(c) { return c.byteLength; } };

    // ---- URLSearchParams --------------------------------------------------------
    if (typeof globalThis.URLSearchParams !== "function") {
        const enc = (s) => encodeURIComponent(s).replace(/%20/g, "+").replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
        const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (e) { return s; } };
        class URLSearchParams {
            #list = [];
            #url = null;
            constructor(init = "") {
                if (init instanceof URLSearchParams) { this.#list = init.#list.map((p) => p.slice()); }
                else if (typeof init === "string") { this._parse(init); }
                else if (Array.isArray(init) || (init && typeof init[Symbol.iterator] === "function")) { for (const [k, v] of init) this.#list.push([String(k), String(v)]); }
                else if (init && typeof init === "object") { for (const k of Object.keys(init)) this.#list.push([k, String(init[k])]); }
            }
            _parse(s) {
                this.#list = [];
                if (s.startsWith("?")) s = s.slice(1);
                for (const part of s.split("&")) {
                    if (!part) continue;
                    const i = part.indexOf("=");
                    if (i < 0) this.#list.push([dec(part), ""]);
                    else this.#list.push([dec(part.slice(0, i)), dec(part.slice(i + 1))]);
                }
            }
            _attach(url) { this.#url = url; }
            _update() { if (this.#url) this.#url.search = this.toString(); }
            get size() { return this.#list.length; }
            append(k, v) { this.#list.push([String(k), String(v)]); this._update(); }
            delete(k, v) { this.#list = this.#list.filter(([a, b]) => !(a === String(k) && (v === undefined || b === String(v)))); this._update(); }
            get(k) { const p = this.#list.find(([a]) => a === String(k)); return p ? p[1] : null; }
            getAll(k) { return this.#list.filter(([a]) => a === String(k)).map(([, b]) => b); }
            has(k, v) { return this.#list.some(([a, b]) => a === String(k) && (v === undefined || b === String(v))); }
            set(k, v) {
                k = String(k); v = String(v);
                const i = this.#list.findIndex(([a]) => a === k);
                if (i < 0) this.#list.push([k, v]);
                else { this.#list[i][1] = v; this.#list = this.#list.filter(([a], j) => a !== k || j === i); }
                this._update();
            }
            sort() { this.#list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._update(); }
            forEach(cb, thisArg) { for (const [k, v] of this.#list) cb.call(thisArg, v, k, this); }
            *entries() { for (const p of this.#list) yield [p[0], p[1]]; }
            *keys() { for (const [k] of this.#list) yield k; }
            *values() { for (const [, v] of this.#list) yield v; }
            [Symbol.iterator]() { return this.entries(); }
            toString() { return this.#list.map(([k, v]) => enc(k) + "=" + enc(v)).join("&"); }
            get [Symbol.toStringTag]() { return "URLSearchParams"; }
        }
        globalThis.URLSearchParams = URLSearchParams;
        // Boa の URL 拡張は searchParams が「未実装」を投げるので、常にこちらで上書きする
        if (typeof URL === "function") {
            const cache = new WeakMap();
            Object.defineProperty(URL.prototype, "searchParams", {
                configurable: true,
                get() {
                    let p = cache.get(this);
                    if (!p) { p = new URLSearchParams(this.search); p._attach(this); cache.set(this, p); }
                    else { p._parse(this.search); }
                    return p;
                },
            });
        }
    }

    // ---- FormData -------------------------------------------------------------
    class FormData {
        #list = [];
        constructor(form) {
            if (form && typeof form.querySelectorAll === "function") {
                for (const el of form.querySelectorAll("input, textarea, select")) {
                    const name = el.getAttribute("name");
                    if (!name || el.disabled) continue;
                    const type = (el.getAttribute("type") || "").toLowerCase();
                    if ((type === "checkbox" || type === "radio") && !el.checked) continue;
                    if (type === "submit" || type === "button" || type === "file") continue;
                    this.#list.push([name, String(el.value ?? "")]);
                }
            }
        }
        append(k, v, filename) { this.#list.push([String(k), v instanceof Blob ? (filename !== undefined && !(v instanceof File) ? new File([v], filename, { type: v.type }) : v) : String(v)]); }
        set(k, v, filename) { this.delete(k); this.append(k, v, filename); }
        delete(k) { this.#list = this.#list.filter(([a]) => a !== String(k)); }
        get(k) { const p = this.#list.find(([a]) => a === String(k)); return p ? p[1] : null; }
        getAll(k) { return this.#list.filter(([a]) => a === String(k)).map(([, v]) => v); }
        has(k) { return this.#list.some(([a]) => a === String(k)); }
        forEach(cb, thisArg) { for (const [k, v] of this.#list) cb.call(thisArg, v, k, this); }
        *entries() { for (const p of this.#list) yield [p[0], p[1]]; }
        *keys() { for (const [k] of this.#list) yield k; }
        *values() { for (const [, v] of this.#list) yield v; }
        [Symbol.iterator]() { return this.entries(); }
        /** multipart/form-data にエンコードする */
        _encode() {
            const boundary = "----sunameri" + Math.random().toString(16).slice(2) + Date.now().toString(16);
            const chunks = [];
            for (const [k, v] of this.#list) {
                if (v instanceof Blob) {
                    const name = v instanceof File ? v.name : "blob";
                    chunks.push(utf8Encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${name}"\r\nContent-Type: ${v.type || "application/octet-stream"}\r\n\r\n`));
                    chunks.push(v._bytes());
                    chunks.push(utf8Encoder.encode("\r\n"));
                } else {
                    chunks.push(utf8Encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
                }
            }
            chunks.push(utf8Encoder.encode(`--${boundary}--\r\n`));
            return { bytes: concat(chunks), contentType: "multipart/form-data; boundary=" + boundary };
        }
        get [Symbol.toStringTag]() { return "FormData"; }
    }
    globalThis.FormData = FormData;

    // ---- 本文の正規化 ------------------------------------------------------------
    // 戻り値: { bytes: Uint8Array|null, contentType: string|null }
    const normalizeBody = (body) => {
        if (body === null || body === undefined) return { bytes: null, contentType: null };
        if (typeof body === "string") return { bytes: utf8Encoder.encode(body), contentType: "text/plain;charset=UTF-8" };
        if (body instanceof URLSearchParams) return { bytes: utf8Encoder.encode(body.toString()), contentType: "application/x-www-form-urlencoded;charset=UTF-8" };
        if (body instanceof FormData) { const e = body._encode(); return { bytes: e.bytes, contentType: e.contentType }; }
        if (body instanceof Blob) return { bytes: body._bytes(), contentType: body.type || null };
        if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { bytes: toUint8(body), contentType: null };
        if (body instanceof ReadableStream) return { bytes: body._bytes(), contentType: null };
        return { bytes: utf8Encoder.encode(String(body)), contentType: "text/plain;charset=UTF-8" };
    };

    // ---- Body mixin ------------------------------------------------------------
    const bodyMixin = {
        get bodyUsed() { return this._bodyUsed === true; },
        get body() {
            if (this._bytes === null) return null;
            const bytes = this._bytes;
            return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
        },
        _consume() {
            if (this._bodyUsed) return Promise.reject(new TypeError("body stream already read"));
            this._bodyUsed = true;
            return Promise.resolve(this._bytes ?? new Uint8Array(0));
        },
        text() { return this._consume().then((b) => utf8Decoder.decode(b)); },
        json() { return this.text().then((t) => JSON.parse(t)); },
        arrayBuffer() { return this._consume().then((b) => b.slice().buffer); },
        bytes() { return this._consume().then((b) => b.slice()); },
        blob() { return this._consume().then((b) => new Blob([b], { type: this.headers.get("content-type") || "" })); },
        formData() {
            return this.text().then((t) => {
                const fd = new FormData();
                for (const [k, v] of new URLSearchParams(t)) fd.append(k, v);
                return fd;
            });
        },
    };

    // ---- Request ---------------------------------------------------------------
    class Request {
        constructor(input, init = {}) {
            let url, base = {};
            if (input instanceof Request) { base = input; url = input.url; }
            else { url = String(input); }
            try { url = new URL(url, location.href).href; } catch (e) { throw new TypeError("Failed to construct 'Request': Invalid URL " + url); }
            const method = String(init.method ?? base.method ?? "GET").toUpperCase();
            const headers = new Headers(init.headers ?? base.headers);
            let bytes = null;
            if (init.body !== undefined && init.body !== null) {
                const n = normalizeBody(init.body);
                bytes = n.bytes;
                if (n.contentType && !headers.has("content-type")) headers.set("content-type", n.contentType);
            } else if (base._bytes) {
                bytes = base._bytes;
            }
            if (bytes !== null && (method === "GET" || method === "HEAD")) throw new TypeError("Request with GET/HEAD method cannot have body.");
            Object.defineProperties(this, {
                url: { value: url, enumerable: true },
                method: { value: method, enumerable: true },
                headers: { value: headers, enumerable: true },
                credentials: { value: init.credentials ?? base.credentials ?? "same-origin", enumerable: true },
                mode: { value: init.mode ?? base.mode ?? "cors", enumerable: true },
                cache: { value: init.cache ?? base.cache ?? "default", enumerable: true },
                redirect: { value: init.redirect ?? base.redirect ?? "follow", enumerable: true },
                referrer: { value: init.referrer ?? "about:client", enumerable: true },
                referrerPolicy: { value: init.referrerPolicy ?? "", enumerable: true },
                integrity: { value: init.integrity ?? "", enumerable: true },
                keepalive: { value: !!(init.keepalive ?? base.keepalive), enumerable: true },
                signal: { value: init.signal ?? base.signal ?? new AbortSignal(), enumerable: true },
                destination: { value: "", enumerable: true },
                duplex: { value: "half", enumerable: true },
                priority: { value: init.priority ?? "auto", enumerable: true },
            });
            this._bytes = bytes;
            this._bodyUsed = false;
        }
        clone() { const r = new Request(this); r._bytes = this._bytes; return r; }
        get [Symbol.toStringTag]() { return "Request"; }
    }
    Object.defineProperties(Request.prototype, Object.getOwnPropertyDescriptors(bodyMixin));

    // ---- Response --------------------------------------------------------------
    class Response {
        constructor(body = null, init = {}) {
            const status = init.status === undefined ? 200 : Number(init.status);
            if (!Number.isInteger(status) || status < 200 || status > 599) {
                throw new RangeError("The status provided (" + status + ") is outside the range [200, 599].");
            }
            const headers = new Headers(init.headers);
            let bytes = null;
            if (body !== null && body !== undefined) {
                const n = normalizeBody(body);
                bytes = n.bytes;
                if (n.contentType && !headers.has("content-type")) headers.set("content-type", n.contentType);
            }
            Object.defineProperties(this, {
                status: { value: status, enumerable: true },
                statusText: { value: init.statusText === undefined ? "" : String(init.statusText), enumerable: true },
                headers: { value: headers, enumerable: true },
                url: { value: init.url === undefined ? "" : String(init.url), enumerable: true },
                type: { value: init.type ?? "basic", enumerable: true },
                redirected: { value: !!init.redirected, enumerable: true },
            });
            this._bytes = bytes;
            this._bodyUsed = false;
        }
        get ok() { return this.status >= 200 && this.status <= 299; }
        clone() {
            if (this._bodyUsed) throw new TypeError("Response body is already used");
            const r = new Response(null, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url, type: this.type, redirected: this.redirected });
            r._bytes = this._bytes;
            return r;
        }
        static error() { const r = new Response(null, { status: 200, type: "error" }); Object.defineProperty(r, "status", { value: 0 }); return r; }
        static redirect(url, status = 302) { return new Response(null, { status, headers: { location: String(url) } }); }
        static json(data, init = {}) { const h = new Headers(init.headers); if (!h.has("content-type")) h.set("content-type", "application/json"); return new Response(JSON.stringify(data), { ...init, headers: h }); }
        get [Symbol.toStringTag]() { return "Response"; }
    }
    Object.defineProperties(Response.prototype, Object.getOwnPropertyDescriptors(bodyMixin));

    globalThis.Request = Request;
    globalThis.Response = Response;

    // ---- fetch -----------------------------------------------------------------
    const rawFetch = (url, method, headers, bytes, follow) => {
        const body = bytes === null ? null : Array.from(bytes);
        return __blitz_fetch_async(url, method, headers, body, follow);
    };

    globalThis.fetch = function fetch(input, init) {
        let request;
        try { request = new Request(input, init); } catch (e) { return Promise.reject(e); }
        if (request.signal && request.signal.aborted) {
            return Promise.reject(request.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        }
        const headers = [...request.headers.entries()];
        const bytes = request.method === "GET" || request.method === "HEAD" ? null : request._bytes;
        return new Promise((resolve, reject) => {
            let settled = false;
            const onAbort = () => { if (!settled) { settled = true; reject(request.signal.reason ?? new DOMException("The operation was aborted.", "AbortError")); } };
            if (request.signal) request.signal.addEventListener("abort", onAbort);
            rawFetch(request.url, request.method, headers, bytes, request.redirect !== "manual").then(
                ([status, statusText, url, respHeaders, body, redirected]) => {
                    if (settled) return;
                    settled = true;
                    if (request.redirect === "error" && status >= 300 && status < 400) { reject(new TypeError("Redirect refused")); return; }
                    if (request.redirect === "manual" && status >= 300 && status < 400) {
                        const r = new Response(null, { status: 200, type: "opaqueredirect", url: "" });
                        Object.defineProperty(r, "status", { value: 0 });
                        resolve(r);
                        return;
                    }
                    const safeStatus = status >= 200 && status <= 599 ? status : 200;
                    const response = new Response(null, { status: safeStatus, statusText, headers: respHeaders, url, redirected });
                    if (safeStatus !== status) Object.defineProperty(response, "status", { value: status });
                    response._bytes = request.method === "HEAD" ? new Uint8Array(0) : body;
                    resolve(response);
                },
                (err) => { if (!settled) { settled = true; reject(err instanceof TypeError ? err : new TypeError(String(err && err.message || err))); } }
            );
        });
    };

    // ---- XMLHttpRequest ----------------------------------------------------------
    class XMLHttpRequestEventTarget {
        constructor() { this._listeners = Object.create(null); }
        addEventListener(type, cb) { if (typeof cb !== "function" && !(cb && typeof cb.handleEvent === "function")) return; (this._listeners[type] ??= []).push(cb); }
        removeEventListener(type, cb) { if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((l) => l !== cb); }
        dispatchEvent(event) {
            try { Object.defineProperty(event, "target", { value: this, configurable: true }); } catch (e) {}
            try { Object.defineProperty(event, "currentTarget", { value: this, configurable: true }); } catch (e) {}
            const handler = this["on" + event.type];
            if (typeof handler === "function") { try { handler.call(this, event); } catch (e) { reportUncaught(e); } }
            for (const l of (this._listeners[event.type] || []).slice()) {
                try { typeof l === "function" ? l.call(this, event) : l.handleEvent(event); } catch (e) { reportUncaught(e); }
            }
            return true;
        }
        _fire(type, extra = {}) {
            const event = { type, bubbles: false, cancelable: false, defaultPrevented: false, timeStamp: Date.now(), isTrusted: true, lengthComputable: false, loaded: 0, total: 0, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra };
            this.dispatchEvent(event);
        }
    }
    const reportUncaught = (e) => { try { console.error("Uncaught " + (e instanceof Error ? e.name + ": " + e.message : String(e)) + (e && e.stack ? "\n" + e.stack : "")); } catch (_) {} };

    class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {}

    class XMLHttpRequest extends XMLHttpRequestEventTarget {
        static UNSENT = 0; static OPENED = 1; static HEADERS_RECEIVED = 2; static LOADING = 3; static DONE = 4;
        constructor() {
            super();
            this.readyState = 0;
            this.status = 0;
            this.statusText = "";
            this.responseType = "";
            this.responseURL = "";
            this.timeout = 0;
            this.withCredentials = false;
            this.upload = new XMLHttpRequestUpload();
            this.onreadystatechange = null;
            this._method = "GET";
            this._url = "";
            this._headers = [];
            this._respHeaders = [];
            this._bytes = null;
            this._aborted = false;
            this._sent = false;
            this._mime = null;
        }
        get UNSENT() { return 0; } get OPENED() { return 1; } get HEADERS_RECEIVED() { return 2; } get LOADING() { return 3; } get DONE() { return 4; }
        _setState(state) {
            this.readyState = state;
            if (typeof this.onreadystatechange === "function") { try { this.onreadystatechange({ type: "readystatechange", target: this }); } catch (e) { reportUncaught(e); } }
            this._fire("readystatechange");
        }
        open(method, url, async = true, user, password) {
            this._method = String(method).toUpperCase();
            try { this._url = new URL(String(url), location.href).href; } catch (e) { throw new DOMException("Invalid URL", "SyntaxError"); }
            this._headers = [];
            this._bytes = null;
            this._sent = false;
            this._aborted = false;
            this.status = 0;
            this.statusText = "";
            this._setState(1);
        }
        setRequestHeader(name, value) {
            if (this.readyState !== 1) throw new DOMException("InvalidStateError", "InvalidStateError");
            this._headers.push([String(name), String(value)]);
        }
        overrideMimeType(mime) { this._mime = String(mime); }
        getResponseHeader(name) {
            name = String(name).toLowerCase();
            const values = this._respHeaders.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);
            return values.length ? values.join(", ") : null;
        }
        getAllResponseHeaders() { return this._respHeaders.map(([k, v]) => k.toLowerCase() + ": " + v + "\r\n").join(""); }
        send(body = null) {
            if (this.readyState !== 1 || this._sent) throw new DOMException("InvalidStateError", "InvalidStateError");
            this._sent = true;
            let bytes = null;
            if (this._method !== "GET" && this._method !== "HEAD" && body !== null && body !== undefined) {
                const n = normalizeBody(body);
                bytes = n.bytes;
                if (n.contentType && !this._headers.some(([k]) => k.toLowerCase() === "content-type")) this._headers.push(["content-type", n.contentType]);
            }
            let timedOut = false;
            let timer = null;
            if (this.timeout > 0) {
                timer = setTimeout(() => { timedOut = true; this._finishError("timeout"); }, this.timeout);
            }
            this._fire("loadstart");
            rawFetch(this._url, this._method, this._headers, bytes, true).then(
                ([status, statusText, url, headers, respBody]) => {
                    if (timer) clearTimeout(timer);
                    if (this._aborted || timedOut) return;
                    this.status = status;
                    this.statusText = statusText;
                    this.responseURL = url;
                    this._respHeaders = headers;
                    this._setState(2);
                    this._bytes = respBody;
                    this._setState(3);
                    this._setState(4);
                    this._fire("progress", { lengthComputable: true, loaded: respBody.byteLength, total: respBody.byteLength });
                    this._fire("load", { lengthComputable: true, loaded: respBody.byteLength, total: respBody.byteLength });
                    this._fire("loadend");
                },
                (err) => {
                    if (timer) clearTimeout(timer);
                    if (this._aborted || timedOut) return;
                    this._finishError("error");
                }
            );
        }
        _finishError(kind) {
            this.status = 0;
            this.statusText = "";
            this._bytes = null;
            if (this.readyState !== 4) this._setState(4);
            this._fire(kind);
            this._fire("loadend");
        }
        abort() {
            if (this._sent && this.readyState !== 4) {
                this._aborted = true;
                this._finishError("abort");
            }
            this.readyState = 0;
        }
        get responseText() {
            if (this.responseType !== "" && this.responseType !== "text") throw new DOMException("InvalidStateError", "InvalidStateError");
            return this._bytes ? utf8Decoder.decode(this._bytes) : "";
        }
        get responseXML() { return null; }
        get response() {
            if (this.readyState !== 4 || !this._bytes) return this.responseType === "" || this.responseType === "text" ? "" : null;
            switch (this.responseType) {
                case "": case "text": return utf8Decoder.decode(this._bytes);
                case "json": try { return JSON.parse(utf8Decoder.decode(this._bytes)); } catch (e) { return null; }
                case "arraybuffer": return this._bytes.slice().buffer;
                case "blob": return new Blob([this._bytes], { type: this.getResponseHeader("content-type") || "" });
                case "document": return null;
                default: return null;
            }
        }
        get [Symbol.toStringTag]() { return "XMLHttpRequest"; }
    }
    globalThis.XMLHttpRequest = XMLHttpRequest;
    globalThis.XMLHttpRequestUpload = XMLHttpRequestUpload;
    globalThis.XMLHttpRequestEventTarget = XMLHttpRequestEventTarget;
    globalThis.ProgressEvent = globalThis.ProgressEvent ?? function ProgressEvent(type, init = {}) { return { type, ...init }; };
})();
