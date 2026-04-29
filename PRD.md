# Product Requirements Document
## Real-Time Visual Assistant for the Visually Impaired

---

## 1. Overview

A mobile-first web application that uses the device camera to continuously analyze the user's surroundings and deliver real-time audio descriptions. Designed specifically for blind and visually impaired users, the app narrates what is in front of them — obstacles, hazards, people, and traffic signals — allowing safe and independent navigation.

All AI inference runs in the user's browser via **WebAssembly (WASM)**. The model is downloaded once and stored permanently in **IndexedDB** on the device — no cloud, no server, no data ever leaves the phone.

---

## 2. Problem Statement

Blind and visually impaired people face significant challenges navigating unfamiliar environments independently. Existing solutions (white canes, guide dogs) are effective but limited — they cannot identify traffic light states, read signage, or describe complex scenes. This app fills that gap using AI vision running entirely inside the browser, with no dependency on internet connectivity or cloud services after the initial setup.

---

## 3. Target Users

- Totally blind individuals navigating outdoors and indoors
- People with severe low vision who need scene interpretation
- Age range: all adults, with a focus on older users who may have lower tech literacy

---

## 4. Goals

- Provide continuous, spoken descriptions of what is directly in front of the user
- Warn of obstacles and hazards within 1–3 meters
- Detect and announce traffic light state (red / green / unknown)
- Work fully offline after the first-time model download
- Be operable with zero visual interaction (fully audio/gesture controlled)
- Never send any image, audio, or personal data to any external server

---

## 5. Core Features

### 5.1 Continuous Camera Analysis
- Access the rear camera in real time via `getUserMedia()`
- Capture a frame every 1–2 seconds using the Canvas API
- Feed each frame to the vision model with a navigation-specific prompt
- Speak the result aloud via the Web Speech API (`speechSynthesis`)

### 5.2 Obstacle Detection & Path Assessment
- Identify objects in the immediate path (steps, curbs, walls, people, bicycles, vehicles, furniture)
- Classify path as: **clear**, **obstacle ahead**, or **danger**
- Priority prompt: *"Is the path ahead clear? List any obstacles within close range."*

### 5.3 Traffic Light Detection
- Detect whether a traffic light is visible in frame
- Report state: **red (stop)**, **green (go)**, **yellow (caution)**, or **not visible**
- Announce traffic light state with higher urgency — interrupts ongoing speech immediately

### 5.4 Audio Output
- All output delivered via text-to-speech — no reading required
- Short, direct phrases: *"Path clear."* / *"Step down ahead."* / *"Red light."*
- Adjustable speech rate and volume
- Urgent warnings (obstacles, red light) cancel and replace any ongoing speech

### 5.5 Hands-Free Operation
- Single tap anywhere: pause / resume analysis
- Double tap: repeat last description
- Long press: cycle between modes
- Optional: voice trigger word to activate

---

## 6. Analysis Modes

| Mode | Prompt Used | Frequency | Use Case |
|---|---|---|---|
| **Navigation** | "Is the path ahead clear? List any obstacles." | Every 1.5s | Walking outdoors/indoors |
| **Traffic** | "Is there a traffic light? What color is it?" | Every 1s | Crossing roads |
| **Scene** | "Describe the environment around me in detail." | On demand | Orientation in a new place |
| **Read** | "Read any text visible in this image." | On demand | Signs, menus, labels |

Mode switching: long press → cycle, or double-tap + say mode name.

---

## 7. Technical Architecture

### Frontend (React PWA)
- React + PWA (installable to phone home screen via `manifest.json`)
- `getUserMedia()` for rear camera stream
- Canvas API to extract frames from the video stream
- Web Speech API (`speechSynthesis`) for audio output
- `@huggingface/transformers` for on-device WASM inference
- Service Worker for offline support

### AI Inference — WebAssembly (WASM)
- **Runtime:** ONNX Runtime Web in WASM mode (`ort-wasm`)
- **Model:** SmolVLM-500M-Instruct, quantized to int8/q4 for WASM performance
- **No WebGPU required** — runs on CPU via WASM, works on any modern browser
- Inference runs in a **Web Worker** so it never blocks the UI thread
- WASM backend chosen over WebGPU for universal browser support (Android Chrome, iOS Safari, Firefox, Samsung Internet)

### Model Storage — IndexedDB
- On first launch, model weights are downloaded from HuggingFace (~150–300 MB)
- Weights are stored in **IndexedDB** under a versioned key (e.g. `smolvlm-500m-v1`)
- On all subsequent launches, model is loaded directly from IndexedDB — **no network request**
- Storage is persistent (`navigator.storage.persist()` requested on first load)
- If the user clears browser data, they are prompted to re-download on next launch
- Model files broken into chunks to stay within IndexedDB single-record limits

### Performance Targets
- Frame capture → spoken output: under 3 seconds on mid-range phone (WASM is slower than WebGPU; this is acceptable for navigation)
- Model load from IndexedDB on startup: under 5 seconds
- Battery impact: acceptable for 30-minute continuous sessions

---

## 8. Privacy & Security

| Property | Detail |
|---|---|
| Image data | Never leaves the device — processed in-browser only |
| Model weights | Stored in IndexedDB on the user's device |
| Network requests | Only the initial model download from HuggingFace CDN |
| After download | 100% offline, zero outbound connections |
| No account | No login, no registration, no tracking |
| No analytics | No telemetry, error reporting, or usage data collected |

> The app is more private than a native app — WASM runs in the browser sandbox with no OS-level permissions beyond camera access.

---

## 9. Platform Requirements

| Requirement | Detail |
|---|---|
| Browser | Any modern browser with WASM support |
| Android | Chrome 90+, Firefox 90+, Samsung Internet 14+ |
| iOS | Safari 16.4+ (iOS 16.4+) — full support |
| Desktop | Chrome, Firefox, Edge, Safari — all supported |
| Storage | ~300 MB free for model in IndexedDB |
| Network | Required only for first model download |
| Camera | Rear-facing camera |

> WASM eliminates the WebGPU requirement entirely, making iOS Safari support possible for the first time.

---

## 10. User Interface

- **Fullscreen camera view** — screen shows what the camera sees (useful for sighted helpers)
- **Large status bar** at bottom: current mode + last spoken text (for sighted companions)
- **First-launch download screen**: progress bar with spoken progress ("Downloading model, 40%...")
- Minimal visual UI — interface is audio-first
- High-contrast, large-font text for low-vision users with some remaining sight
- Screen stays on while active (Wake Lock API)

---

## 11. First-Launch Flow

1. User opens the app (PWA or browser URL)
2. App checks IndexedDB for existing model
3. **If not found:** show download screen, speak *"Downloading the AI model. This will take about two minutes and only happens once."*
4. Download model chunks from HuggingFace, store each chunk in IndexedDB as it arrives
5. Speak progress updates: *"Download 25% complete"*, *"50%"*, etc.
6. Once complete: *"Model ready. Tap anywhere to begin."*
7. **If found in IndexedDB:** load directly, speak *"Loading model..."*, ready in ~5 seconds
8. Request camera permission, request persistent storage (`navigator.storage.persist()`)
9. Begin analysis loop

---

## 12. Out of Scope (V1)

- Face recognition or identifying specific individuals
- Navigation routing / GPS integration
- Multiple language TTS (English only in V1)
- Cloud-based fallback inference
- Recording or logging sessions
- Custom wake word detection

---

## 13. Success Metrics

| Metric | Target |
|---|---|
| Obstacle detection accuracy | >85% within 2 meters |
| Traffic light detection accuracy | >90% in clear daylight |
| End-to-end latency (frame → speech) | <3 seconds on WASM |
| False positive obstacle warnings | <10% of announcements |
| Offline functionality after setup | 100% |
| iOS Safari compatibility | Full support |
| Model re-download rate (IndexedDB persistence) | <5% of sessions |

---

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| WASM slower than WebGPU on some devices | Reduce frame rate dynamically; show latency warning if >4s |
| IndexedDB storage quota exceeded | Check quota before download; prompt user to free space |
| User clears browser storage (wipes model) | Detect on launch and re-prompt for download gracefully |
| iOS Safari IndexedDB limits | Chunk model into <50MB segments; request persistent storage |
| Incorrect obstacle detection causes harm | Strong audio disclaimer on first launch; conservative prompts |
| Traffic light misread | Higher confidence threshold before announcing; say "light unclear" if uncertain |
| Battery drain during long sessions | Auto-pause after 30s of no motion (device motion sensor) |
| Camera permission denied | Clear spoken instructions on how to grant permission |

---

## 15. Development Phases

### Phase 1 — Core Navigation (MVP)
- IndexedDB model download + storage system
- Rear camera stream capture and frame extraction
- WASM inference loop in a Web Worker
- Text-to-speech output
- Navigation mode (obstacle detection)
- Basic tap gesture controls
- First-launch spoken onboarding

### Phase 2 — Traffic Light Detection
- Dedicated traffic mode with 1s frame rate
- Urgent audio announcement for red/green
- "Light unclear" fallback when confidence is low

### Phase 3 — Polish & Accessibility
- All 4 modes fully implemented
- Wake Lock (screen stays on)
- PWA installable on home screen
- Dynamic frame rate based on device speed
- Spoken download progress with percentage
- User testing with visually impaired participants

---

## 16. Key Technical Decisions

| Decision | Choice | Reason |
|---|---|---|
| Inference backend | WASM (not WebGPU) | Works on iOS Safari and all browsers, not just Chrome/Edge |
| Model storage | IndexedDB (not Cache API) | Explicit control, persistent across sessions, works offline reliably |
| Threading | Web Worker | Keeps UI and audio responsive during inference |
| Model size | 500M parameters (q4) | Balance of accuracy and speed on mobile WASM |
| Audio output | Web Speech API | Built-in, no extra library, works on all target platforms |

---

*Document version: 2.0 — April 2026*
