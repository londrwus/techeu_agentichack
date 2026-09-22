// Fetch-with-cache + React data hooks. Ported from vanilla js/lib.js api().
import { useEffect, useState } from 'react';
import { MODULE_IDS } from './meta.js';

const cache = new Map();

export async function api(path, { fresh = false } = {}) {
  if (!fresh && cache.has(path)) return cache.get(path);
  const p = fetch(path).then(r => (r.ok ? r.json() : null)).catch(e => { console.warn('[api]', path, e); return null; });
  cache.set(path, p);
  const v = await p;
  if (v == null) cache.delete(path);
  return v;
}

/** All four product modules (cached). Missing ones are skipped. */
export async function allModules() {
  const res = await Promise.all(MODULE_IDS.map(id => api(`/api/modules/${id}`)));
  return res.filter(Boolean);
}

export const loadModule = id => api(`/api/modules/${id}`);

/** Await `fn` once per key change; returns { data, loading }. Ignores results after unmount. */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: undefined, loading: true });
  useEffect(() => {
    // Synchronising with the network: flip to loading, then publish the result.
    let alive = true;
    setState(s => ({ data: s.data, loading: true }));
    Promise.resolve()
      .then(fn)
      .then(data => alive && setState({ data, loading: false }))
      .catch(e => { console.error('[useAsync]', e); if (alive) setState({ data: undefined, loading: false }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** GET a JSON endpoint (cached). */
export const useApi = (path, opts) => useAsync(() => (path ? api(path, opts) : null), [path]);

/** The module payload for a screen: /api/modules/{id}. */
export const useModule = id => useApi(id ? `/api/modules/${id}` : null);
