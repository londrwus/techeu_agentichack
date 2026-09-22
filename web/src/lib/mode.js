// Deploy mode from /api/mode. The public showcase locks live scans (Jev / DeepSeek / Modal)
// to the recording from the hackathon stage; a local run keeps everything live.
import { useEffect, useState } from 'react';
import { api } from './api.js';

let mode = { showcase: false, llm: null };
const ready = api('/api/mode').then(m => { if (m) mode = m; return mode; });

export const isShowcase = () => mode.showcase;

export function useMode() {
  const [m, setM] = useState(mode);
  useEffect(() => { let alive = true; ready.then(v => alive && setM(v)); return () => { alive = false; }; }, []);
  return m;
}
