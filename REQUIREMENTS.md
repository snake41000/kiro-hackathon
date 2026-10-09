# Requirements: Character Voice Agent

Build it **one milestone at a time**. Each milestone must work in the browser
before starting the next. Keep the code simple: few files, no build step.

## Stack (use exactly this)

- **Backend:** Python 3.12+, **FastAPI** + **uvicorn**, managed with **uv**.
  Packages: `fastapi`, `uvicorn[standard]`, `python-dotenv`, `boto3`,
  `langgraph`, `langchain-aws` (+ `aws-sdk-transcribe-streaming[awscrt]` for
  bonus A). The app is **`main.py`** (with `app = FastAPI()`) at the top of the
  folder; it also serves the frontend from `public/`.
- **Frontend:** plain HTML, CSS and JavaScript modules. **No npm, no build
  step, no React.** Libraries from a CDN with an import map:
  - `three` 0.186.1: `https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js`
  - `three/addons/`: `https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/`
  - `@pixiv/three-vrm` 3.5.5: `https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3.5.5/lib/three-vrm.module.min.js`
- **Browser ↔ server:** one **WebSocket** per page (`/ws`), JSON messages.
- **AI:** a **LangGraph** agent with **Amazon Nova Lite** (`ChatBedrockConverse`,
  model `us.amazon.nova-lite-v1:0`, region `us-east-1`).
- **Voice:** **Amazon Polly**, neural voice.
- **AWS region:** always **`us-east-1`**. Pass `region_name="us-east-1"` to every
  boto3 client and to `ChatBedrockConverse` (boto3 doesn't always read
  `AWS_REGION` by itself).
- **AWS keys** come from `.env` (load it with `python-dotenv`). Never hard-code,
  print or send keys to the browser. The app must also run **without `.env`**
  (on the server it uses the server's AWS role).
- **Character settings** in `character.json`: `name`, `avatar`
  (`/avatars/CoolPineapple.vrm`), `voice` (Polly voice ID, engine `neural`),
  `personality`, `greeting`, `background` (2 colors). The personality stays on
  the server.

## Assets (provided, don't rename)

- `public/avatars/CoolPineapple.vrm`: the 3D character (VRM 0.x).
- `public/animations/`: `idle`, `thinking`, `talking`, `dance`, `fall-flat`,
  `stand-up` (`.fbx`, from Mixamo, without skin).
- `public/music/dance.mp3`: music for the dance.

---

## Milestone 1: The character appears

- The page shows the avatar full body, facing the camera, on a colored background.
- It plays `idle` in a loop and blinks every few seconds.
- A "Click to start" screen first (browsers block sound until a click); after
  the click, an intro: `fall-flat`, then `stand-up`, then `idle`.

## Milestone 2: It thinks

- A text box + Send button (Enter sends). The message goes to the server over
  the WebSocket; the server answers with Nova Lite in the character's
  personality, and the page shows the answer.
- The character remembers the conversation while the page is open.
- Answers are short (1–3 sentences), no lists or emojis.
- One answer at a time (Send disabled while waiting); messages cut to 500
  characters; on failure, a short friendly error and the user can retry.

## Milestone 3: It speaks

- Each answer is spoken with Polly, with the voice from `character.json`.
- The mouth moves in sync with the voice (lip sync from Polly visemes).
- A speech bubble shows the answer while speaking, then disappears.

## Milestone 4: It feels and moves

- Each answer includes an **emotion** (`neutral`, `happy`, `angry`, `sad`,
  `relaxed`) chosen by the AI; the face shows it while speaking.
- Animations follow what's happening: `thinking` while waiting for the answer,
  `talking` while speaking, `idle` otherwise, with smooth crossfades.
- A **Dance** button: `dance` in a loop with `dance.mp3`; pressing it again (or
  sending a message) stops it.

## Milestone 5: It's yours

- After "Click to start", the character says its `greeting`.
- Your own `name`, `personality`, `greeting`, voice and colors.

## Bonuses

- **A. It listens:** hold a button (or Space, but not while typing) to talk;
  the microphone streams to the server, Amazon Transcribe turns it into text,
  live words show while talking, `thinking` plays, and the final text is
  answered like a typed message. Stop recording after 30 s. Hide the button
  when the page isn't on `localhost` or `https`.
- **B. It picks its own moves:** `moves` in `character.json` (animation file +
  a `when` description); each answer includes a `move` (or `none`) chosen by
  the AI; looping moves like the dance start after the voice ends.
- **C. Superpowers:** tools the AI can call (dice, quiz score, facts),
  effects, new Mixamo moves, another avatar.
- **D. It's online:** deploy to your server (README, step 4).

---

## Technical notes (tested solutions for the hard parts)

**Loading the VRM.** `GLTFLoader` with `register(parser => new VRMLoaderPlugin(parser))`;
the avatar is `gltf.userData.vrm`. Call `VRMUtils.rotateVRM0(vrm)` (or it faces
away), set `frustumCulled = false` on all its objects, and **every frame** call
`mixer.update(delta)`, then `vrm.update(delta)`, then render. Camera:
`PerspectiveCamera(30, aspect, 0.1, 20)` at `(0, 1.0, 4.0)` looking at
`(0, 0.75, 0)`; renderer with `alpha: true` so the CSS background shows.

**Face.** `vrm.expressionManager.setValue(name, 0..1)` with VRM 1.0 names (also
for VRM 0.x files): emotions `happy`, `angry`, `sad`, `relaxed` (~0.7 while
speaking); mouth `aa`, `ih`, `ou`, `ee`, `oh`; `blink`.

**Mixamo animations on a VRM (retargeting).** The FBX bones have other names
and rest poses, so each clip must be converted when loaded (same method as the
official three-vrm example "humanoidAnimation" / `loadMixamoAnimation.js`):
1. `FBXLoader`; the clip is `AnimationClip.findByName(fbx.animations, "mixamo.com")`.
2. Each track is `mixamorigBone.property`. Map the bone name (table below) and
   get the VRM node with `vrm.humanoid.getNormalizedBoneNode(name)`; skip
   unknown bones.
3. Rotations: with `R` = the Mixamo bone's rest **world** rotation and `P` =
   its parent's rest world rotation, each keyframe `q` becomes `P × q × R⁻¹`.
4. VRM 0.x (`vrm.meta.metaVersion === "0"`): negate the x and z parts of each
   quaternion, and of the hips position.
5. Hips position: scale by `vrmHipsHeight / mixamoHipsHeight` (VRM hips world
   y minus `vrm.scene` world y, divided by the FBX `mixamorigHips` position y).
6. Name new tracks `<vrmNode.name>.<property>`; play with an `AnimationMixer`
   on `vrm.scene`; switch clips with `crossFadeTo(next, 0.4)`.

Bones: `Hips`→hips, `Spine`→spine, `Spine1`→chest, `Spine2`→upperChest,
`Neck`→neck, `Head`→head, `LeftShoulder`→leftShoulder, `LeftArm`→leftUpperArm,
`LeftForeArm`→leftLowerArm, `LeftHand`→leftHand, `LeftUpLeg`→leftUpperLeg,
`LeftLeg`→leftLowerLeg, `LeftFoot`→leftFoot, `LeftToeBase`→leftToes (same for
Right; all prefixed `mixamorig`). Fingers: `LeftHandThumb1/2/3`→
`leftThumbMetacarpal/Proximal/Distal`, `LeftHandIndex1/2/3`→
`leftIndexProximal/Intermediate/Distal`, and Middle, Ring, Pinky (→`Little`)
the same way.

Intro: play `fall-flat` and `stand-up` once (`LoopOnce`, `clampWhenFinished`,
wait for the mixer's `finished` event). `stand-up` starts with ~3 s lying
still: skip 2.5 s and play it 1.6× faster.

**Voice (Polly).** For each answer call `synthesize_speech` twice in parallel
(in threads): `OutputFormat="mp3"` for the sound, and `OutputFormat="json"`
with `SpeechMarkTypes=["viseme", "word"]` for timings (one JSON object per
line, `time` in ms). Send the mp3 as base64 with the visemes. In the browser,
play it with one `AudioContext` (call `resume()` after the first click);
`decodeAudioData`, then an `AudioBufferSourceNode`.

**Lip sync.** Each frame: `now = (context.currentTime - startTime - (context.outputLatency || 0)) × 1000`;
take the last viseme with `time ≤ now` and set the mouth (others to 0):
`a`→aa 1.0 · `@`→aa 0.5 · `e`→ee 0.8 · `E`→ee 0.6 + aa 0.3 · `i`→ih 0.8 ·
`o`→oh 0.9 · `O`→oh 0.7 + aa 0.3 · `u`→ou 0.9 · `t`/`s`/`T`→ih 0.3 ·
`S`→ou 0.3 + ih 0.2 · `k`→aa 0.3 · `r`→ou 0.3 · `f`→ih 0.2 · others → closed.

**AI answer format.** `ChatBedrockConverse(...).with_structured_output(Reply)`
where `Reply` is a Pydantic model: `text`, `emotion` (a `Literal` of the 5
emotions), and for bonus B `move`. Memory: a LangGraph `StateGraph` over
`MessagesState` with an `InMemorySaver` checkpointer, one `thread_id` per
WebSocket, last ~20 messages. For tools: call the model with `bind_tools` once
**before** the answer step (looping until it stops calling tools can loop
forever with Nova Lite).

**Bonus A, microphone and Transcribe.**
- The microphone only works on `localhost` or `https`.
- Browser: `getUserMedia` → an **AudioWorklet** that averages the 44.1/48 kHz
  input down to **16 kHz**, converts to **16-bit PCM**, and sends **100 ms**
  chunks as binary WebSocket frames.
- Server: boto3 **can't** stream to Transcribe: use `aws-sdk-transcribe-streaming`
  (`AsyncTranscribeStreamingClient` with `AWSCRTHTTPClient`), **one client
  reused**, `language_code="en-US"`, `media_sample_rate_hertz=16000`,
  `media_encoding="pcm"`. Send `AudioEvent` chunks to `stream.input_stream` and
  **close it when the user stops** (else: "no new audio for 15 seconds").
- On Linux/Mac run uvicorn with `--loop asyncio` (with uvloop every turn
  hangs).
- Empty transcript every time = muted microphone.
