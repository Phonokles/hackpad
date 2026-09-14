import {
  FaceLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import { Hackpad } from "./hackpad.js";

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const recDot = document.getElementById("recDot");
const connectBtn = document.getElementById("connect");

let faceLandmarker;
let lastVideoTime = -1;
let micStream = null;

// ---------------- Einstellungen (zum Feintunen) ----------------
const SMOOTHING = 0.3;
const ROLL_SMOOTHING = 0.25;
const ROTATION_FACTOR = 0.1;   // max. 1/10 der echten Kopfrotation
const WIGGLE_FACTOR = 0.011;   // Wackeln beim Sprechen, relativ zur Schriftgröße

const FACE_WIDTH = 0.28;       // Anteil der Fensterbreite
const FACE_HEIGHT = 0.5;       // Anteil der Fensterhöhe

const LAUGH_SMILE_MIN = 0.4;
const LAUGH_JAW_MIN = 0.18;
const SURPRISE_BROW_MIN = 0.45;
const SURPRISE_EYE_MIN = 0.35;

const BORED_BROW_MIN = 0.35;
const BORED_SMILE_MAX = 0.15;
const BORED_JAW_MAX = 0.12;

const AUDIO_THRESHOLD = 0.045; // RMS-Schwelle für "ich rede"
const AUDIO_HOLD_MS = 250;     // wie lange "sprechend" nach letztem lauten Sample bleibt
const FLAP_INTERVAL_MS = 150;  // Mundwechsel-Geschwindigkeit beim Sprechen

// ---------------- State ----------------
const smoothed = { jaw: 0, smile: 0, browDown: 0, browInnerUp: 0, eyeWide: 0 };
let smoothedRoll = 0;

let transparentMode = false; // false = schwarzer Hintergrund, true = transparent (für OBS)
let mode = "auto";           // "auto" | "manual"
let manualExpression = "normal"; // "normal" | "laughing" | "bored"
let manualTalkOverride = false;  // Encoder gedrückt gehalten

let lastLoudTime = 0;
let flapChar = "_";
let lastFlapToggle = 0;

let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];

let vw = 0, vh = 0;

function getScore(categories, name) {
  const c = categories.find(c => c.categoryName === name);
  return c ? c.score : 0;
}
function ema(prev, next, a) { return prev + (next - prev) * a; }

// ---------------- Canvas auf Fenstergröße ----------------
function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  vw = window.innerWidth;
  vh = window.innerHeight;
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  canvas.style.width = vw + "px";
  canvas.style.height = vh + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", fitCanvas);
fitCanvas();

// ---------------- Setup ----------------
async function init() {
  const filesetResolver = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU"
    },
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: "VIDEO",
    numFaces: 1
  });

  micStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: true
  });
  video.srcObject = micStream;

  setupAudioMeter(micStream);

  video.addEventListener("loadeddata", () => {
    predictLoop();
    renderLoop();
  });
}

// ---------------- Audio-Erkennung (Lautstärke) ----------------
let analyser, audioData;
function setupAudioMeter(stream) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioData = new Uint8Array(analyser.fftSize);
  source.connect(analyser);
}

function getAudioRms() {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(audioData);
  let sumSquares = 0;
  for (let i = 0; i < audioData.length; i++) {
    const v = (audioData[i] - 128) / 128;
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / audioData.length);
}

// ---------------- Video-Tracking-Loop ----------------
function predictLoop() {
  const now = performance.now();
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = faceLandmarker.detectForVideo(video, now);
    processVideoResult(result);
  }
  requestAnimationFrame(predictLoop);
}

function processVideoResult(result) {
  if (!result.faceBlendshapes || result.faceBlendshapes.length === 0) return;
  const cats = result.faceBlendshapes[0].categories;

  const rawJaw = getScore(cats, "jawOpen");
  const rawSmile = (getScore(cats, "mouthSmileLeft") + getScore(cats, "mouthSmileRight")) / 2;
  const rawBrowDown = (getScore(cats, "browDownLeft") + getScore(cats, "browDownRight")) / 2;
  const rawBrowInnerUp = getScore(cats, "browInnerUp");
  const rawEyeWide = (getScore(cats, "eyeWideLeft") + getScore(cats, "eyeWideRight")) / 2;

  smoothed.jaw = ema(smoothed.jaw, rawJaw, SMOOTHING);
  smoothed.smile = ema(smoothed.smile, rawSmile, SMOOTHING);
  smoothed.browDown = ema(smoothed.browDown, rawBrowDown, SMOOTHING);
  smoothed.browInnerUp = ema(smoothed.browInnerUp, rawBrowInnerUp, SMOOTHING);
  smoothed.eyeWide = ema(smoothed.eyeWide, rawEyeWide, SMOOTHING);

  let rollDeg = 0;
  if (result.facialTransformationMatrixes && result.facialTransformationMatrixes.length > 0) {
    const m = result.facialTransformationMatrixes[0].data;
    rollDeg = Math.atan2(m[1], m[0]) * (180 / Math.PI);
  }
  smoothedRoll = ema(smoothedRoll, rollDeg, ROLL_SMOOTHING);
}

// ---------------- Zustandslogik ----------------
function getBaseExpression() {
  if (mode === "manual") return manualExpression;

  const laughing =
    (smoothed.smile > LAUGH_SMILE_MIN && smoothed.jaw > LAUGH_JAW_MIN) ||
    (smoothed.browInnerUp > SURPRISE_BROW_MIN && smoothed.eyeWide > SURPRISE_EYE_MIN);
  if (laughing) return "laughing";

  const bored =
    smoothed.browDown > BORED_BROW_MIN &&
    smoothed.smile < BORED_SMILE_MAX &&
    smoothed.jaw < BORED_JAW_MAX;
  if (bored) return "bored";

  return "normal";
}

function isTalkingNow() {
  if (manualTalkOverride) return true;
  const rms = getAudioRms();
  if (rms > AUDIO_THRESHOLD) lastLoudTime = performance.now();
  return (performance.now() - lastLoudTime) < AUDIO_HOLD_MS;
}

const EXPR_EYES = { normal: "+", laughing: "*", bored: "-" };
const EXPR_ORDER = ["normal", "laughing", "bored"];

// ---------------- Render-Loop (läuft unabhängig, für weiches Wackeln) ----------------
function renderLoop() {
  const expression = getBaseExpression();
  const talking = isTalkingNow();

  const eyes = EXPR_EYES[expression] || "+";

  let mouth = "_";
  if (talking) {
    const now = performance.now();
    if (now - lastFlapToggle > FLAP_INTERVAL_MS) {
      flapChar = flapChar === "_" ? "." : "_";
      lastFlapToggle = now;
    }
    mouth = flapChar;
  }

  const text = `[${eyes}${mouth}${eyes}]`;

  // 5 Zeichen à 0.6em breit -> Schrift aus der Fenstergröße ableiten
  const size = Math.min(vw * FACE_WIDTH, vh * FACE_HEIGHT);
  const wiggle = size * WIGGLE_FACTOR;

  const offsetX = talking ? (Math.random() * wiggle * 2 - wiggle) : 0;
  const offsetY = talking ? (Math.random() * wiggle * 2 - wiggle) : 0;
  const rotation = smoothedRoll * ROTATION_FACTOR;

  drawFace(text, size, offsetX, offsetY, rotation);
  requestAnimationFrame(renderLoop);
}

function drawFace(text, size, offsetX, offsetY, rotationDeg) {
  ctx.clearRect(0, 0, vw, vh);
  if (!transparentMode) {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, vw, vh);
  }
  ctx.save();
  ctx.translate(vw / 2 + offsetX, vh / 2 + offsetY);
  ctx.rotate((rotationDeg * Math.PI) / 180);
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(size)}px "Courier New", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

// ---------------- Aktionen ----------------
function setAuto() { mode = "auto"; }

function setManual(expr) {
  mode = "manual";
  manualExpression = expr;
}

function setTransparent(on) {
  transparentMode = on;
  document.body.style.background = on ? "transparent" : "#000";
}

function toggleRecording() {
  if (!isRecording) startRecording();
  else stopRecording();
}

function startRecording() {
  if (!micStream) return;
  const canvasStream = canvas.captureStream(30);
  const audioTrack = micStream.getAudioTracks()[0];
  const combined = new MediaStream([...canvasStream.getVideoTracks(), audioTrack]);

  let options = { mimeType: "video/webm;codecs=vp9,opus" };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: "video/webm" };
  }

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(combined, options);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "face-aufnahme.webm";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  mediaRecorder.start();
  isRecording = true;
  recDot.classList.add("on");
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
  }
  isRecording = false;
  recDot.classList.remove("on");
}

// ---------------- Steuerung: Hackpad ----------------
// Die drei Taster schalten direkt auf einen Ausdruck.
const BUTTON_EXPR = {
  btn1: "normal",
  btn2: "laughing",
  btn3: "bored",
};

Hackpad.onDown = (name) => {
  if (name === "encoder") { manualTalkOverride = true; return; }
  const expr = BUTTON_EXPR[name];
  if (expr) setManual(expr);
};

Hackpad.onUp = (name) => {
  if (name === "encoder") manualTalkOverride = false;
};

// Aus dem OLED-Menü gewählt
Hackpad.onExpression = (expr) => setManual(expr);

Hackpad.onAction = (action) => {
  if (action === "auto") setAuto();
  if (action === "record") toggleRecording();
  if (action === "transparent") setTransparent(!transparentMode);
};

Hackpad.onStatus = (msg) => {
  if (connectBtn) connectBtn.textContent = msg;
};

if (connectBtn) {
  connectBtn.addEventListener("click", () => Hackpad.connect());
}

// ---------------- Steuerung: Tastatur (Notfall-Backup) ----------------
document.addEventListener("keydown", (e) => {
  switch (e.key) {
    case "0": setAuto(); break;
    case "1": setManual("normal"); break;
    case "3": setManual("laughing"); break;
    case "4": setManual("bored"); break;
    case "2": manualTalkOverride = true; break;
    case "r": case "R": toggleRecording(); break;
    case "t": case "T": setTransparent(!transparentMode); break;
  }
});
document.addEventListener("keyup", (e) => {
  if (e.key === "2") manualTalkOverride = false;
});

init().catch(err => console.error("start fehlgeschlagen:", err));