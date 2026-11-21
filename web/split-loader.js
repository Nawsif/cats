/* Reassembles the two engine files from small, integrity-checked downloads. */
(() => {
  'use strict';
  const scriptURL = new URL(document.currentScript.src), base = new URL('.', scriptURL);
  const manifestURL = new URL('engine/chunks-manifest.json', base);
  manifestURL.search = scriptURL.search;
  const fetchOriginal = window.fetch.bind(window);
  let manifestPromise, active = 0;
  const waiting = [];
  const acquire = () => active < 4 ? (active++, Promise.resolve()) : new Promise(resolve => waiting.push(resolve));
  const release = () => waiting.length ? waiting.shift()() : active--;
  const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
  function manifest() {
    return manifestPromise ||= fetchOriginal(manifestURL).then(async response => {
      if (!response.ok) throw Error('The engine chunk list is missing (HTTP ' + response.status + ').');
      const value = await response.json();
      if (value.version !== 1 || !value.files) throw Error('Unsupported engine chunk list.');
      return value;
    });
  }
  async function loadPart(part, signal) {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          const response = await fetchOriginal(new URL(part.path, base), {signal, credentials:'same-origin'});
          if (!response.ok) throw Error('HTTP ' + response.status);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length !== part.size || hex(await crypto.subtle.digest('SHA-256', bytes)) !== part.sha256)
            throw Error('Integrity check failed');
          return bytes;
        } catch (error) {
          if (signal.aborted) throw error;
          if (attempt === 2) throw Error('Could not load ' + part.path + ': ' + error.message);
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    } finally { release(); }
  }
  async function splitFetch(input, options) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, document.baseURI);
    const relative = url.origin === base.origin && url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) : '';
    if (!/^engine\/(?:admin\/)?arc_boot\.(?:data|wasm)$/.test(relative)) return fetchOriginal(input, options);
    const entry = (await manifest()).files[relative];
    if (!entry) return fetchOriginal(input, options);
    const method = (options?.method || input?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return fetchOriginal(input, options);
    if (!Array.isArray(entry.parts) || entry.parts.reduce((sum, p) => sum + p.size, 0) !== entry.size)
      throw Error('Invalid engine chunk sizes.');
    const headers = {'Content-Type':entry.mime, 'Content-Length':String(entry.size), 'Cross-Origin-Resource-Policy':'same-origin'};
    if (method === 'HEAD') return new Response(null, {status:200, headers});
    const abort = new AbortController(), signal = options?.signal || input?.signal;
    const relay = () => abort.abort(signal.reason);
    if (signal?.aborted) relay(); else signal?.addEventListener('abort', relay, {once:true});
    let next = 0, scheduled = 0;
    const jobs = new Map();
    function fill() {
      while (scheduled < entry.parts.length && scheduled < next + 2) {
        const id = scheduled++, promise = loadPart(entry.parts[id], abort.signal);
        promise.catch(() => {}); jobs.set(id, promise);
      }
    }
    fill();
    const cleanup = () => signal?.removeEventListener('abort', relay);
    const body = new ReadableStream({
      async pull(controller) {
        try {
          if (next === entry.parts.length) { cleanup(); controller.close(); return; }
          const id = next, bytes = await jobs.get(id);
          jobs.delete(id); next++; controller.enqueue(bytes); fill();
        } catch (error) { cleanup(); abort.abort(); controller.error(error); }
      },
      cancel() { cleanup(); abort.abort(); }
    });
    return new Response(body, {status:200, headers});
  }
  window.fetch = splitFetch;
  window.CatsSplitFiles = Object.freeze({manifest, fetch:splitFetch});
})();
