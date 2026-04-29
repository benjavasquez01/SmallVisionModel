import React, { useState, useEffect, useRef, useCallback } from 'react';

const CAPTURE_PX = 256;
const FRAME_MS = 2000;
const MODES = ['navigation', 'traffic', 'scene', 'read'];
const MODE_LABELS = { navigation: 'Navigation', traffic: 'Traffic Light', scene: 'Scene', read: 'Read Text' };
const MODE_ICONS  = { navigation: '🚶', traffic: '🚦', scene: '🌍', read: '📝' };

function fmtBytes(b) {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 ** 2).toFixed(1)} MB`;
}

export default function BlindAssistant({ onShowAbout }) {
  const [phase, setPhase]           = useState('initializing');
  const [mode, setMode]             = useState('navigation');
  const [lastText, setLastText]     = useState('');
  const [statusMsg, setStatusMsg]   = useState('Starting...');
  const [downloaded, setDownloaded] = useState(0);
  const [errorMsg, setErrorMsg]     = useState('');

  const workerRef    = useRef(null);
  const videoRef     = useRef(null);
  const canvasRef    = useRef(null);
  const runningRef   = useRef(false);
  const modeRef      = useRef(mode);
  const phaseRef     = useRef(phase);
  const lastTextRef  = useRef('');
  const downloadRef  = useRef(0);
  const loopTimerRef = useRef(null);

  const tapCountRef  = useRef(0);
  const tapTimerRef  = useRef(null);
  const longPressRef = useRef(null);

  useEffect(() => { modeRef.current = mode; },  [mode]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── TTS ──────────────────────────────────────────────────────────────────────
  const speak = useCallback((text, urgent = false) => {
    if (!text || !window.speechSynthesis) return;
    if (urgent) window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.15;
    window.speechSynthesis.speak(utt);
  }, []);

  // ── Worker setup ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (navigator.storage?.persist) navigator.storage.persist();

    // eslint-disable-next-line no-undef
    const worker = new Worker(new URL('../workers/inferenceWorker.js', import.meta.url));
    workerRef.current = worker;

    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case 'status':
          setStatusMsg(data.message);
          setPhase(p => p === 'initializing' ? 'loading' : p);
          break;
        case 'downloadProgress': {
          const { loaded, total } = data;
          if (loaded !== total) break;
          downloadRef.current += total;
          setDownloaded(downloadRef.current);
          setPhase(p => (p === 'loading' || p === 'ready' || p === 'running' || p === 'paused') ? p : 'downloading');
          break;
        }
        case 'ready':
          setPhase('ready');
          speak('Model ready. Tap anywhere to begin.');
          break;
        case 'result': {
          const { text } = data;
          setLastText(text);
          lastTextRef.current = text;
          speak(text);
          break;
        }
        case 'error':
          setErrorMsg(data.message);
          setPhase('error');
          break;
        default:
          break;
      }
    };

    worker.postMessage({ type: 'init' });

    return () => {
      runningRef.current = false;
      clearTimeout(loopTimerRef.current);
      stopCamera();
      worker.terminate();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Camera ────────────────────────────────────────────────────────────────────
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

  // ── Frame capture → worker ────────────────────────────────────────────────────
  const captureAndSend = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    const worker = workerRef.current;
    if (!video || !canvas || !worker || video.readyState < 2) return;

    canvas.width  = CAPTURE_PX;
    canvas.height = CAPTURE_PX;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, CAPTURE_PX, CAPTURE_PX);
    const imageData = ctx.getImageData(0, 0, CAPTURE_PX, CAPTURE_PX);

    worker.postMessage(
      { type: 'analyze', data: { imageBuffer: imageData.data.buffer, width: CAPTURE_PX, height: CAPTURE_PX, mode: modeRef.current } },
      [imageData.data.buffer]
    );
  }, []);

  // ── Analysis loop ─────────────────────────────────────────────────────────────
  const startLoop = useCallback(() => {
    const tick = () => {
      if (!runningRef.current) return;
      captureAndSend();
      loopTimerRef.current = setTimeout(tick, FRAME_MS);
    };
    tick();
  }, [captureAndSend]);

  const stopLoop = useCallback(() => {
    runningRef.current = false;
    clearTimeout(loopTimerRef.current);
  }, []);

  // ── Gesture handlers ──────────────────────────────────────────────────────────
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
        startLoop();
      }).catch(() => {});
    } else if (p === 'running') {
      stopLoop();
      setPhase('paused');
      speak('Paused.');
    } else if (p === 'paused') {
      runningRef.current = true;
      setPhase('running');
      speak('Resumed.');
      startLoop();
    }
  }, [startCamera, startLoop, stopLoop, speak]);

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

  // ── Render ────────────────────────────────────────────────────────────────────
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
                {fmtBytes(downloaded)} saved to device
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
          <p style={S.privacy}>🔒 On-device · Zero data sent</p>
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
