/* eslint-disable no-restricted-globals */

// Static imports — webpack bundles these into the worker file directly.
// No separate chunk = no blob URL = no MIME type error.
// Transformers.js does NOT call fetch at import time, only in from_pretrained(),
// so our fetch override (set up inside initModel before from_pretrained) is always in place.
import { AutoProcessor, AutoModelForVision2Seq, RawImage, env } from '@huggingface/transformers';

// ─── IndexedDB helpers ──────────────────────────────────────────────────────
const DB_NAME = 'smolvlm-cache-v1';
const DB_STORE = 'files';

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

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Custom fetch (IndexedDB cache) ─────────────────────────────────────────
const HF_DOMAINS = ['huggingface.co', 'hf.co', 'cdn-lfs'];
const MODEL_ID = 'HuggingFaceTB/SmolVLM-500M-Instruct';

function isHFUrl(url) {
  return HF_DOMAINS.some(d => url.includes(d));
}

function guessContentType(url) {
  if (url.endsWith('.json')) return 'application/json; charset=utf-8';
  if (url.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

// Called inside initModel() before from_pretrained() — ensures the override
// is active before any model file requests are made.
function setupFetchOverride() {
  const _fetch = self.fetch.bind(self);

  self.fetch = async function cachedFetch(input, init) {
    const url = typeof input === 'string' ? input : input.url;

    if (!isHFUrl(url)) return _fetch(input, init);

    // Cache hit → serve from IndexedDB, no network
    try {
      const cached = await dbGet(url);
      if (cached) {
        self.postMessage({ type: 'cacheHit', url });
        return new Response(cached, {
          status: 200,
          headers: {
            'content-type': guessContentType(url),
            'content-length': String(cached.byteLength),
          },
        });
      }
    } catch (_) { /* fall through to network */ }

    // Network fetch with progress tracking
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
      if (loaded % (256 * 1024) < value.length) {
        self.postMessage({ type: 'downloadProgress', url, loaded, total });
      }
    }

    const combined = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }

    dbPut(url, combined.buffer).catch(e => console.warn('[worker] IndexedDB write failed:', e));
    self.postMessage({ type: 'downloadProgress', url, loaded, total });

    return new Response(combined.buffer, {
      status: 200,
      headers: {
        'content-type': guessContentType(url),
        'content-length': String(loaded),
      },
    });
  };
}

// ─── Model state ─────────────────────────────────────────────────────────────
let processor = null;
let model = null;
let busy = false;

const PROMPTS = {
  navigation: 'In one short sentence: is the path ahead clear, or are there obstacles? Name specific objects if present.',
  traffic: 'In one short sentence: is a traffic light visible? If yes, what color is it?',
  scene: 'In two sentences, describe the scene and surroundings.',
  read: 'Read any visible text. If there is none, say: no text visible.',
};

// ─── Model loading ───────────────────────────────────────────────────────────
async function initModel() {
  try {
    // Set up IndexedDB-backed fetch BEFORE any from_pretrained() calls
    setupFetchOverride();

    env.backends.onnx.wasm.wasmPaths = '/';
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    env.useFSCache = false;

    self.postMessage({ type: 'status', message: 'Loading processor...' });
    processor = await AutoProcessor.from_pretrained(MODEL_ID);

    self.postMessage({ type: 'status', message: 'Loading vision model (first run takes a few minutes)...' });
    model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
      dtype: {
        embed_tokens: 'fp32',
        vision_encoder: 'q4',
        decoder_model_merged: 'q4',
      },
      // No device: 'webgpu' — defaults to WASM/CPU
    });

    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
}

// ─── Frame analysis ──────────────────────────────────────────────────────────
async function analyzeFrame({ imageBuffer, width, height, mode }) {
  if (!model || !processor || busy) return;
  busy = true;

  try {
    const pixels = new Uint8ClampedArray(imageBuffer);
    const image = new RawImage(pixels, width, height, 4);

    const prompt = PROMPTS[mode] ?? PROMPTS.navigation;
    const messages = [{
      role: 'user',
      content: [{ type: 'image' }, { type: 'text', text: prompt }],
    }];

    const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await processor(text, [image], { do_image_splitting: false });

    const generated = await model.generate({ ...inputs, max_new_tokens: 20 });

    const output = processor.batch_decode(
      generated.slice(null, [inputs.input_ids.dims.at(-1), null]),
      { skip_special_tokens: true }
    );

    self.postMessage({ type: 'result', text: output[0].trim(), mode });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  } finally {
    busy = false;
  }
}

// ─── Message router ──────────────────────────────────────────────────────────
self.onmessage = async ({ data: { type, data } }) => {
  if (type === 'init') await initModel();
  else if (type === 'analyze') await analyzeFrame(data);
  else if (type === 'clearCache') await dbClear();
};
