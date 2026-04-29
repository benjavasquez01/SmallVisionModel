import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── ORT blob MIME-type fix ────────────────────────────────────────────────────
// onnxruntime-web 1.22.0-dev creates Blob objects without a MIME type, then calls
// import(URL.createObjectURL(blob)) with /*webpackIgnore:true*/, bypassing webpack.
// Browsers reject import() of a blob typed as text/plain (the default).
// We patch createObjectURL once, at module load time, to ensure any typeless blob
// is re-wrapped as application/javascript before a URL is minted.
;(function patchCreateObjectURL() {
  const _orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    if (obj instanceof Blob && !obj.type) {
      return _orig(new Blob([obj], { type: 'application/javascript' }));
    }
    return _orig(obj);
  };
})();

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
const DB_NAME = 'smolvlm-cache-v1';
const DB_STORE = 'files';
const HF_DOMAINS = ['huggingface.co', 'hf.co', 'cdn-lfs'];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function guessContentType(url) {
  if (url.endsWith('.json')) return 'application/json; charset=utf-8';
  if (url.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

// Overrides window.fetch to cache HuggingFace model files in IndexedDB.
// Called before the first from_pretrained() so all model downloads go through here.
function setupFetchOverride(onProgress) {
  const _fetch = window.fetch.bind(window);
  window.fetch = async function cachedFetch(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (!HF_DOMAINS.some(d => url.includes(d))) return _fetch(input, init);

    try {
      const cached = await dbGet(url);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: { 'content-type': guessContentType(url), 'content-length': String(cached.byteLength) },
        });
      }
    } catch (_) { /* fall through */ }

    const response = await _fetch(input, init);
    if (!response.ok) return response;

    const total = parseInt(response.headers.get('content-length') ?? '0', 10);
    let loaded = 0;
    const chunks = [];
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (loaded % (256 * 1024) < value.length) onProgress({ loaded, total, url });
    }

    const combined = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }

    dbPut(url, combined.buffer).catch(e => console.warn('IndexedDB write failed:', e));
    onProgress({ loaded, total, url });

    return new Response(combined.buffer, {
      status: 200,
      headers: { 'content-type': guessContentType(url), 'content-length': String(loaded) },
    });
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────
const MODEL_ID = 'HuggingFaceTB/SmolVLM-500M-Instruct';
const CAPTURE_PX = 448;
const FRAME_MS = 2500;
const MODES = ['navigation', 'traffic', 'scene', 'read'];
const MODE_LABELS = { navigation: 'Navigation', traffic: 'Traffic Light', scene: 'Scene', read: 'Read Text' };
const MODE_ICONS  = { navigation: '🚶', traffic: '🚦', scene: '🌍', read: '📝' };
const PROMPTS = {
  navigation: 'In one short sentence: is the path ahead clear, or are there obstacles? Name specific objects.',
  traffic:    'In one short sentence: is a traffic light visible? If yes, what color is it?',
  scene:      'In two sentences, describe the scene and surroundings.',
  read:       'Read any visible text. If there is none, say: no text visible.',
};

function fmtBytes(b) {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 ** 2).toFixed(1)} MB`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function BlindAssistant({ onShowAbout }) {
  const [phase, setPhase]           = useState('initializing');
  const [mode, setMode]             = useState('navigation');
  const [lastText, setLastText]     = useState('');
  const [statusMsg, setStatusMsg]   = useState('Starting...');
  const [downloaded, setDownloaded] = useState(0);
  const [errorMsg, setErrorMsg]     = useState('');

  const modelRef     = useRef(null);
  const processorRef = useRef(null);
  const videoRef     = useRef(null);
  const canvasRef    = useRef(null);
  const runningRef   = useRef(false); // controls the analysis loop
  const busyRef      = useRef(false); // true while inference is in progress
  const modeRef      = useRef(mode);
  const phaseRef     = useRef(phase);
  const lastTextRef  = useRef('');
  const downloadRef  = useRef(0);

  // tap gesture tracking
  const tapCountRef     = useRef(0);
  const tapTimerRef     = useRef(null);
  const longPressRef    = useRef(null);

  useEffect(() => { modeRef.current = mode; },  [mode]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── TTS ────────────────────────────────────────────────────────────────────
  const speak = useCallback((text, urgent = false) => {
    if (!text || !window.speechSynthesis) return;
    if (urgent) window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.15;
    window.speechSynthesis.speak(utt);
  }, []);

  // ── Model loading ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (navigator.storage?.persist) navigator.storage.persist();

    setupFetchOverride(({ loaded, total, url }) => {
      // Only count each file's final chunk (avoid double-counting progress ticks)
      if (!url || loaded !== total) return;
      downloadRef.current += total;
      setDownloaded(downloadRef.current);
      setPhase(p => p === 'loading' || p === 'ready' || p === 'running' ? p : 'downloading');
    });

    (async () => {
      try {
        // Dynamic import works fine in the main thread — webpack uses <script> tags,
        // not blob URLs, so MIME types are always correct.
        const { AutoProcessor, AutoModelForVision2Seq, env } = await import('@huggingface/transformers');

        // Serve ORT runtime files from public/ instead of CDN.
        // Transformers.js sets wasmPaths to its own CDN by default, where the ORT
        // files don't actually exist (they're a different package). Pointing to '/'
        // uses the files we copied to public/ (ort-wasm-simd-threaded.*).
        env.backends.onnx.wasm.wasmPaths = '/';
        // numThreads=1 disables SharedArrayBuffer-based threading, so ORT never
        // creates its thread-worker blob. Combined with the createObjectURL patch
        // above, this eliminates all blob-URL-as-module-script failures.
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
        env.useFSCache = false;

        setPhase('loading');
        setStatusMsg('Loading processor...');
        processorRef.current = await AutoProcessor.from_pretrained(MODEL_ID);

        setStatusMsg('Loading vision model (first run downloads ~300 MB)...');
        modelRef.current = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
          dtype: { embed_tokens: 'fp32', vision_encoder: 'q4', decoder_model_merged: 'q4' },
        });

        setPhase('ready');
        speak('Model ready. Tap anywhere to begin.');
      } catch (err) {
        console.error('Model load error:', err);
        setErrorMsg(err.message);
        setPhase('error');
      }
    })();

    return () => { runningRef.current = false; stopCamera(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Camera ─────────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err) {
      setErrorMsg('Camera access denied. Allow camera and reload.');
      setPhase('error');
      speak('Camera access denied. Please allow camera access and reload the page.');
      throw err;
    }
  }, [speak]);

  const stopCamera = () => {
    const v = videoRef.current;
    if (v?.srcObject) { v.srcObject.getTracks().forEach(t => t.stop()); v.srcObject = null; }
  };

  // ── Inference loop (main thread) ───────────────────────────────────────────
  // speechSynthesis runs in a separate browser thread, so audio plays even
  // while WASM inference occupies the main thread.
  const runLoop = useCallback(async () => {
    const { RawImage } = await import('@huggingface/transformers');

    while (runningRef.current) {
      if (!busyRef.current && modelRef.current && processorRef.current) {
        const video  = videoRef.current;
        const canvas = canvasRef.current;

        if (video && canvas && video.readyState >= 2) {
          busyRef.current = true;
          try {
            canvas.width  = CAPTURE_PX;
            canvas.height = CAPTURE_PX;
            canvas.getContext('2d').drawImage(video, 0, 0, CAPTURE_PX, CAPTURE_PX);

            const blob  = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
            const image = await RawImage.fromBlob(blob);
            const prompt = PROMPTS[modeRef.current] ?? PROMPTS.navigation;

            const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] }];
            const text   = processorRef.current.apply_chat_template(messages, { add_generation_prompt: true });
            const inputs = await processorRef.current(text, [image], { do_image_splitting: false });
            const generated = await modelRef.current.generate({ ...inputs, max_new_tokens: 40 });
            const output = processorRef.current.batch_decode(
              generated.slice(null, [inputs.input_ids.dims.at(-1), null]),
              { skip_special_tokens: true }
            );
            const result = output[0].trim();
            setLastText(result);
            lastTextRef.current = result;
            speak(result);
          } catch (err) {
            console.error('Inference error:', err);
          } finally {
            busyRef.current = false;
          }
        }
      }
      // Wait between frames regardless of whether inference ran
      await new Promise(res => setTimeout(res, FRAME_MS));
    }
  }, [speak]);

  // ── Gesture handlers ───────────────────────────────────────────────────────
  const cycleMode = useCallback(() => {
    const next = MODES[(MODES.indexOf(modeRef.current) + 1) % MODES.length];
    setMode(next);
    modeRef.current = next;
    speak(`${MODE_LABELS[next]} mode.`, true);
  }, [speak]);

  const handleSingleTap = useCallback(() => {
    const p = phaseRef.current;
    if (p === 'ready') {
      startCamera().then(() => {
        runningRef.current = true;
        setPhase('running');
        speak(`Starting. ${MODE_LABELS[modeRef.current]} mode.`);
        runLoop();
      }).catch(() => {});
    } else if (p === 'running') {
      runningRef.current = false;
      setPhase('paused');
      speak('Paused.');
    } else if (p === 'paused') {
      runningRef.current = true;
      setPhase('running');
      speak('Resumed.');
      runLoop();
    }
  }, [startCamera, runLoop, speak]);

  const handleDoubleTap = useCallback(() => {
    if (lastTextRef.current) speak(lastTextRef.current, true);
  }, [speak]);

  const onPointerDown = useCallback(() => {
    longPressRef.current = setTimeout(() => {
      longPressRef.current = null;
      cycleMode();
    }, 700);
  }, [cycleMode]);

  const onPointerUp = useCallback(() => {
    if (!longPressRef.current) return;
    clearTimeout(longPressRef.current);
    longPressRef.current = null;

    tapCountRef.current += 1;
    if (tapCountRef.current === 1) {
      tapTimerRef.current = setTimeout(() => {
        tapCountRef.current = 0;
        handleSingleTap();
      }, 300);
    } else {
      clearTimeout(tapTimerRef.current);
      tapCountRef.current = 0;
      handleDoubleTap();
    }
  }, [handleSingleTap, handleDoubleTap]);

  const onPointerCancel = useCallback(() => {
    clearTimeout(longPressRef.current);
    longPressRef.current = null;
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      style={{ position: 'relative', width: '100vw', height: '100vh', background: '#000', overflow: 'hidden', userSelect: 'none', touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <video
        ref={videoRef}
        playsInline muted
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
          display: phase === 'running' || phase === 'paused' ? 'block' : 'none',
        }}
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Loading / Downloading */}
      {(phase === 'initializing' || phase === 'downloading' || phase === 'loading') && (
        <div style={S.overlay}>
          <div style={S.card}>
            <div style={S.spinner} />
            <h2 style={{ margin: '0 0 8px', color: '#00BFA5', fontSize: 22 }}>
              {phase === 'downloading' ? 'Downloading AI model...' : 'Loading AI model...'}
            </h2>
            {downloaded > 0 && (
              <p style={{ margin: '0 0 4px', color: '#555', fontSize: 14 }}>
                {fmtBytes(downloaded)} saved to IndexedDB
              </p>
            )}
            <p style={{ margin: '4px 0 0', color: '#888', fontSize: 13 }}>{statusMsg}</p>
            {phase === 'downloading' && (
              <p style={{ margin: '12px 0 0', color: '#aaa', fontSize: 12, textAlign: 'center' }}>
                First run only — stored privately on your device.<br />Future loads are instant.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Ready */}
      {phase === 'ready' && (
        <div style={S.overlay}>
          <div style={S.card}>
            <div style={{ fontSize: 56, marginBottom: 8 }}>👁️</div>
            <h2 style={{ margin: '0 0 8px', color: '#00BFA5', fontSize: 24 }}>Ready</h2>
            <p style={{ margin: '0 0 16px', color: '#555', fontSize: 15, textAlign: 'center' }}>
              Tap to start the camera and begin analysis.
            </p>
            <div style={{ color: '#777', fontSize: 13, lineHeight: 2, textAlign: 'left' }}>
              <div><strong>Tap</strong> — start / pause / resume</div>
              <div><strong>Double tap</strong> — repeat last description</div>
              <div><strong>Long press</strong> — change mode</div>
            </div>
            <button
              style={S.secondaryBtn}
              onPointerDown={e => e.stopPropagation()}
              onPointerUp={e => { e.stopPropagation(); onShowAbout(); }}
            >
              ℹ️ About
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {phase === 'error' && (
        <div style={S.overlay}>
          <div style={{ ...S.card, borderColor: '#EF5350' }}>
            <div style={{ fontSize: 48, marginBottom: 8 }}>⚠️</div>
            <h2 style={{ margin: '0 0 8px', color: '#C62828' }}>Error</h2>
            <p style={{ margin: 0, color: '#555', fontSize: 13, textAlign: 'center' }}>{errorMsg}</p>
            <button
              style={{ ...S.secondaryBtn, marginTop: 20 }}
              onPointerDown={e => e.stopPropagation()}
              onPointerUp={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      )}

      {/* Status bar */}
      {(phase === 'running' || phase === 'paused') && (
        <div style={S.statusBar}>
          <div style={S.modeRow}>
            <span style={S.modeTag}>{MODE_ICONS[mode]} {MODE_LABELS[mode]}</span>
            {phase === 'paused' && (
              <span style={{ ...S.modeTag, background: 'rgba(255,160,0,0.85)' }}>⏸ Paused</span>
            )}
          </div>
          {lastText
            ? <p style={S.descText}>{lastText}</p>
            : <p style={{ ...S.descText, color: '#aaa', fontStyle: 'italic' }}>Analyzing...</p>
          }
          <p style={S.hint}>Tap · Double-tap to repeat · Long press to change mode</p>
          <p style={S.privacy}>🔒 On-device · IndexedDB · Zero data sent</p>
        </div>
      )}
    </div>
  );
}

const S = {
  overlay: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.85)', zIndex: 10, padding: 24,
  },
  card: {
    background: '#fff', borderRadius: 16, padding: '32px 28px',
    maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
    border: '2px solid #00BFA5',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
  },
  spinner: {
    width: 44, height: 44, marginBottom: 20,
    border: '4px solid #e0e0e0', borderTopColor: '#00BFA5',
    borderRadius: '50%', animation: 'spin 1s linear infinite',
  },
  statusBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    background: 'rgba(0,0,0,0.78)', padding: '12px 16px 20px',
    backdropFilter: 'blur(8px)',
  },
  modeRow:  { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  modeTag:  { background: 'rgba(0,191,165,0.85)', color: '#fff', padding: '3px 10px', borderRadius: 20, fontSize: 13, fontWeight: 600 },
  descText: { margin: '0 0 8px', color: '#fff', fontSize: 16, lineHeight: 1.5 },
  hint:     { margin: '0 0 4px', color: '#aaa', fontSize: 11 },
  privacy:  { margin: 0, color: '#666', fontSize: 11 },
  secondaryBtn: {
    marginTop: 16, padding: '8px 20px', background: 'transparent',
    color: '#00897B', border: '2px solid #00897B', borderRadius: 8,
    cursor: 'pointer', fontWeight: 600, fontSize: 14,
  },
};
