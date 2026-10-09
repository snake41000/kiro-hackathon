import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  VRMLoaderPlugin,
  VRMUtils,
} from "@pixiv/three-vrm";
import { loadMixamoAnimation } from "/loadMixamoAnimation.js";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
let vrm = null;
let mixer = null;
let currentAction = null;
const actions = {}; // name -> AnimationAction
const clock = new THREE.Clock();

let character = null;
let ws = null;

let audioContext = null;
let currentSource = null; // AudioBufferSourceNode
let currentVisemes = null;
let speechStartTime = 0;
let speaking = false;
let currentEmotion = "neutral";

let turnId = 0; // increments every user turn; stale replies are dropped
let dancing = false;
let danceAudio = null;

const EMOTIONS = ["happy", "angry", "sad", "relaxed"];
const MOUTH_SHAPES = ["aa", "ih", "ou", "ee", "oh"];

// Procedural motion state (natural movement while speaking).
let talkEnergy = 0;

// DOM
const canvas = document.getElementById("scene");
const bubble = document.getElementById("bubble");
const overlay = document.getElementById("start-overlay");
const startTitle = document.getElementById("start-title");
const controls = document.getElementById("controls");
const statusEl = document.getElementById("status");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const talkBtn = document.getElementById("talk");
const stopBtn = document.getElementById("stop");
const danceBtn = document.getElementById("dance");

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  30,
  window.innerWidth / window.innerHeight,
  0.1,
  20
);
camera.position.set(0, 1.0, 4.0);
camera.lookAt(0, 0.75, 0);

const light = new THREE.DirectionalLight(0xffffff, 2.0);
light.position.set(1, 1.5, 1.2);
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 1.2));

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Blink
// ---------------------------------------------------------------------------
let blinkTimer = 0;
let nextBlink = 2 + Math.random() * 3;
let blinkPhase = 0; // 0 = not blinking

function updateBlink(delta) {
  if (!vrm?.expressionManager) return;
  blinkTimer += delta;
  if (blinkPhase > 0) {
    blinkPhase -= delta * 8;
    const v = Math.max(0, Math.sin(Math.max(0, blinkPhase) * Math.PI));
    vrm.expressionManager.setValue("blink", v);
    if (blinkPhase <= 0) {
      blinkPhase = 0;
      vrm.expressionManager.setValue("blink", 0);
    }
  } else if (blinkTimer >= nextBlink) {
    blinkTimer = 0;
    nextBlink = 2 + Math.random() * 3;
    blinkPhase = 1;
  }
}

// ---------------------------------------------------------------------------
// Expressions / emotion
// ---------------------------------------------------------------------------
function setEmotion(emotion, weight) {
  if (!vrm?.expressionManager) return;
  for (const e of EMOTIONS) {
    vrm.expressionManager.setValue(e, e === emotion ? weight : 0);
  }
}

function clearMouth() {
  if (!vrm?.expressionManager) return;
  for (const m of MOUTH_SHAPES) vrm.expressionManager.setValue(m, 0);
}

// ---------------------------------------------------------------------------
// Lip sync
// ---------------------------------------------------------------------------
const VISEME_MAP = {
  a: { aa: 1.0 },
  "@": { aa: 0.5 },
  e: { ee: 0.8 },
  E: { ee: 0.6, aa: 0.3 },
  i: { ih: 0.8 },
  o: { oh: 0.9 },
  O: { oh: 0.7, aa: 0.3 },
  u: { ou: 0.9 },
  t: { ih: 0.3 },
  s: { ih: 0.3 },
  T: { ih: 0.3 },
  S: { ou: 0.3, ih: 0.2 },
  k: { aa: 0.3 },
  r: { ou: 0.3 },
  f: { ih: 0.2 },
};

function updateLipSync() {
  if (!speaking || !currentVisemes || !audioContext) return;
  const now =
    (audioContext.currentTime -
      speechStartTime -
      (audioContext.outputLatency || 0)) *
    1000;

  let active = null;
  for (const v of currentVisemes) {
    if (v.time <= now) active = v;
    else break;
  }

  clearMouth();
  talkEnergy *= 0.85;
  if (active && active.value) {
    const shape = VISEME_MAP[active.value];
    if (shape) {
      for (const [k, val] of Object.entries(shape)) {
        vrm.expressionManager.setValue(k, val);
        talkEnergy = Math.max(talkEnergy, val);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Natural procedural movement while speaking
// ---------------------------------------------------------------------------
const _euler = new THREE.Euler();
const _restQuats = new Map();

function applyProceduralMotion(delta, t) {
  if (!vrm?.humanoid) return;
  const bones = ["head", "neck", "spine", "chest"];
  const intensity = speaking ? 0.5 + talkEnergy : 0.08; // subtle idle sway too

  for (let bi = 0; bi < bones.length; bi++) {
    const node = vrm.humanoid.getNormalizedBoneNode(bones[bi]);
    if (!node) continue;
    const falloff = 1 - bi * 0.2;
    const speed = 1.6 + bi * 0.3;
    const nod = Math.sin(t * speed) * 0.04 * intensity * falloff;
    const tilt = Math.sin(t * (speed * 0.6) + bi) * 0.03 * intensity * falloff;
    const sway = Math.sin(t * (speed * 0.4) + bi * 2) * 0.03 * intensity * falloff;
    _euler.set(nod, sway, tilt, "XYZ");
    node.quaternion.multiply(_tmpQuatFromEuler(_euler));
  }
}

const _tmpQuat = new THREE.Quaternion();
function _tmpQuatFromEuler(e) {
  return _tmpQuat.setFromEuler(e);
}

// ---------------------------------------------------------------------------
// Animation loading + crossfade
// ---------------------------------------------------------------------------
const ANIM_FILES = {
  idle: "/animations/idle.fbx",
  thinking: "/animations/thinking.fbx",
  talking: "/animations/talking.fbx",
  dance: "/animations/dance.fbx",
  "fall-flat": "/animations/fall-flat.fbx",
  "stand-up": "/animations/stand-up.fbx",
};

async function loadAllAnimations() {
  for (const [name, url] of Object.entries(ANIM_FILES)) {
    try {
      const clip = await loadMixamoAnimation(url, vrm);
      const action = mixer.clipAction(clip);
      actions[name] = action;
    } catch (err) {
      console.error("Failed to load animation", name, err);
    }
  }
}

function playAction(name, { loop = true, fade = 0.4 } = {}) {
  const next = actions[name];
  if (!next) return null;
  next.reset();
  next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  next.clampWhenFinished = !loop;
  next.enabled = true;
  next.setEffectiveWeight(1);
  if (currentAction && currentAction !== next) {
    next.crossFadeFrom(currentAction, fade, false);
  }
  next.play();
  currentAction = next;
  return next;
}

// ---------------------------------------------------------------------------
// Intro: fall-flat -> stand-up -> idle
// ---------------------------------------------------------------------------
function playIntro() {
  return new Promise((resolve) => {
    const fall = playAction("fall-flat", { loop: false, fade: 0.1 });
    if (!fall) {
      playAction("idle");
      resolve();
      return;
    }
    const onFinished = (e) => {
      if (e.action === fall) {
        mixer.removeEventListener("finished", onFinished);
        const stand = playAction("stand-up", { loop: false, fade: 0.2 });
        if (stand) {
          stand.time = 2.5; // skip the ~2.5s lying still
          stand.timeScale = 1.6; // play faster
          const onStand = (e2) => {
            if (e2.action === stand) {
              mixer.removeEventListener("finished", onStand);
              playAction("idle");
              resolve();
            }
          };
          mixer.addEventListener("finished", onStand);
        } else {
          playAction("idle");
          resolve();
        }
      }
    };
    mixer.addEventListener("finished", onFinished);
  });
}

// ---------------------------------------------------------------------------
// Load VRM
// ---------------------------------------------------------------------------
async function loadVRM(url) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  vrm = gltf.userData.vrm;
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });
  scene.add(vrm.scene);
  mixer = new THREE.AnimationMixer(vrm.scene);
  await loadAllAnimations();
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  const t = clock.elapsedTime;

  if (mixer) mixer.update(delta);

  if (vrm) {
    updateBlink(delta);
    updateLipSync();
    if (!dancing) applyProceduralMotion(delta, t);
    if (vrm.lookAt) vrm.lookAt.target = camera;
    vrm.update(delta);
  }

  renderer.render(scene, camera);
}
animate();

// ---------------------------------------------------------------------------
// Speech playback
// ---------------------------------------------------------------------------
async function speak(text, emotion, audioB64, marks) {
  stopSpeaking(); // clear any prior audio

  currentEmotion = emotion || "neutral";
  currentVisemes = (marks || []).filter((m) => m.type === "viseme");

  bubble.textContent = text;
  bubble.classList.remove("hidden");

  setEmotion(currentEmotion, 0.7);
  playAction("talking");

  // Decode and play audio.
  const bytes = Uint8Array.from(atob(audioB64), (c) => c.charCodeAt(0));
  const buffer = await audioContext.decodeAudioData(bytes.buffer);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  currentSource = source;
  speechStartTime = audioContext.currentTime;
  speaking = true;

  source.onended = () => {
    if (source === currentSource) finishSpeaking();
  };
  source.start();
}

function finishSpeaking() {
  speaking = false;
  currentSource = null;
  currentVisemes = null;
  clearMouth();
  setEmotion(currentEmotion, 0);
  currentEmotion = "neutral";
  bubble.classList.add("hidden");
  if (!dancing) playAction("idle");
  setStatus("");
}

function stopSpeaking() {
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop();
    } catch (e) {}
    currentSource = null;
  }
  speaking = false;
  currentVisemes = null;
  clearMouth();
  setEmotion(currentEmotion, 0);
  bubble.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Interruption
// ---------------------------------------------------------------------------
function interrupt() {
  turnId++; // any in-flight reply for an older turn will be ignored
  stopSpeaking();
  stopDance();
  if (vrm) playAction("idle");
  setStatus("");
}

// ---------------------------------------------------------------------------
// Dance
// ---------------------------------------------------------------------------
function toggleDance() {
  if (dancing) {
    stopDance();
    return;
  }
  interrupt();
  dancing = true;
  playAction("dance");
  danceBtn.textContent = "⏹ Stop dancing";
  danceAudio = new Audio("/music/dance.mp3");
  danceAudio.loop = true;
  danceAudio.play().catch(() => {});
}

function stopDance() {
  if (!dancing) return;
  dancing = false;
  danceBtn.textContent = "💃 Dance";
  if (danceAudio) {
    danceAudio.pause();
    danceAudio.currentTime = 0;
    danceAudio = null;
  }
  if (vrm) playAction("idle");
}

// ---------------------------------------------------------------------------
// Status helper
// ---------------------------------------------------------------------------
function setStatus(text) {
  statusEl.textContent = text;
}

function setBusy(busy) {
  sendBtn.disabled = busy;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    // Drop stale replies from interrupted turns.
    if (data.turn !== undefined && data.turn !== turnId) return;

    if (data.type === "reply") {
      setBusy(false);
      speak(data.text, data.emotion, data.audio, data.marks);
      if (data.move === "dance") {
        // start dance after speaking ends
        const check = setInterval(() => {
          if (!speaking) {
            clearInterval(check);
            if (!dancing) toggleDance();
          }
        }, 200);
      }
    } else if (data.type === "error") {
      setBusy(false);
      setStatus(data.text);
      if (vrm) playAction("idle");
    } else if (data.type === "partial") {
      setStatus("🎤 " + data.text);
    } else if (data.type === "final") {
      if (data.text) {
        setStatus("You: " + data.text);
      } else {
        setStatus("(didn't catch that)");
        setBusy(false);
        if (vrm && !speaking) playAction("idle");
      }
    }
  };

  ws.onclose = () => setStatus("Disconnected. Refresh to reconnect.");
}

function sendChat(text) {
  text = text.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  interrupt();
  const myTurn = turnId;
  setBusy(true);
  setStatus("");
  if (vrm) playAction("thinking");
  ws.send(JSON.stringify({ type: "chat", turn: myTurn, text }));
}

// ---------------------------------------------------------------------------
// Push-to-talk (Transcribe)
// ---------------------------------------------------------------------------
let micStream = null;
let micNode = null;
let micSourceNode = null;
let recording = false;
let recordTimeout = null;

async function startRecording() {
  if (recording || !ws || ws.readyState !== WebSocket.OPEN) return;
  interrupt();
  const myTurn = turnId;
  recording = true;
  talkBtn.classList.add("recording");
  setStatus("🎤 Listening…");
  if (vrm) playAction("thinking");

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    recording = false;
    talkBtn.classList.remove("recording");
    setStatus("Microphone blocked.");
    return;
  }

  await audioContext.resume();
  await audioContext.audioWorklet.addModule("/pcm-worklet.js");

  micSourceNode = audioContext.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(audioContext, "pcm-worklet", {
    processorOptions: { targetSampleRate: 16000, inputSampleRate: audioContext.sampleRate },
  });
  micNode.port.onmessage = (e) => {
    if (ws && ws.readyState === WebSocket.OPEN && recording) {
      ws.send(e.data); // ArrayBuffer of 16-bit PCM
    }
  };
  micSourceNode.connect(micNode);
  // Do not connect to destination (avoid echo).

  ws.send(JSON.stringify({ type: "mic_start", turn: myTurn }));

  recordTimeout = setTimeout(stopRecording, 30000); // 30s cap
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  talkBtn.classList.remove("recording");
  clearTimeout(recordTimeout);

  if (micSourceNode) micSourceNode.disconnect();
  if (micNode) micNode.disconnect();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = micNode = micSourceNode = null;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "mic_stop", turn: turnId }));
    setBusy(true);
    setStatus("Thinking…");
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
sendBtn.addEventListener("click", () => {
  sendChat(input.value);
  input.value = "";
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat(input.value);
    input.value = "";
  }
});

stopBtn.addEventListener("click", interrupt);
danceBtn.addEventListener("click", toggleDance);
bubble.addEventListener("click", interrupt);

// Hold-to-talk (mouse)
talkBtn.addEventListener("mousedown", startRecording);
talkBtn.addEventListener("mouseup", stopRecording);
talkBtn.addEventListener("mouseleave", () => recording && stopRecording());
// Touch
talkBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  startRecording();
});
talkBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  stopRecording();
});

// Hold Space to talk (when not typing)
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement !== input && !recording) {
    e.preventDefault();
    startRecording();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && recording) {
    e.preventDefault();
    stopRecording();
  }
});

// Hide mic button if not on localhost/https (mic unavailable).
function micAvailable() {
  return (
    location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  );
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function init() {
  character = await (await fetch("/character")).json();
  const [a, b] = character.background || ["#ffd56b", "#ff7eb3"];
  document.documentElement.style.setProperty("--bg-a", a);
  document.documentElement.style.setProperty("--bg-b", b);
  startTitle.textContent = character.name || "Character";
  document.title = character.name || "Character Voice Agent";

  await loadVRM(character.avatar);
  playAction("idle"); // something to show behind the overlay

  overlay.querySelector("p").textContent = "Click to start";
}

overlay.addEventListener("click", async () => {
  overlay.classList.add("hidden");
  controls.classList.remove("hidden");
  if (!micAvailable()) talkBtn.classList.add("hidden");

  // AudioContext must be created/resumed after a user gesture.
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  await audioContext.resume();

  connectWS();
  await playIntro();

  // Milestone 5: speak the greeting.
  if (character.greeting) {
    sendGreeting(character.greeting);
  }
});

function sendGreeting(text) {
  // Speak the greeting text verbatim (no LLM round-trip).
  const myTurn = ++turnId;
  if (!ws) return;
  const wait = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      clearInterval(wait);
      setBusy(true);
      ws.send(JSON.stringify({ type: "chat", turn: myTurn, text: "__greeting__:" + text }));
    }
  }, 100);
}

init().catch((err) => {
  console.error(err);
  startTitle.textContent = "Failed to load";
  overlay.querySelector("p").textContent = String(err);
});
