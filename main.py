"""Character Voice Agent backend.

FastAPI app that serves the frontend from public/ and runs one WebSocket per
page. The agent uses Amazon Nova Lite (Bedrock) for in-character replies,
Amazon Polly for speech + lip-sync visemes, and Amazon Transcribe for
push-to-talk voice input. Runs on localhost; also works without .env on a
server with an AWS role.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

import boto3
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Load .env if present. On a server without .env, boto3 uses the instance role.
load_dotenv()

REGION = "us-east-1"
ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"

# ---------------------------------------------------------------------------
# Character config
# ---------------------------------------------------------------------------
with open(ROOT / "character.json", "r", encoding="utf-8") as f:
    CHARACTER = json.load(f)

VOICE_ID = CHARACTER.get("voice", "Matthew")
VOICE_ENGINE = CHARACTER.get("engine", "neural")
PERSONALITY = CHARACTER.get("personality", "A friendly character.")
NAME = CHARACTER.get("name", "Character")

SYSTEM_PROMPT = (
    f"You are {NAME}. {PERSONALITY}\n"
    "Stay fully in character at all times. Reply in 1 to 3 short sentences. "
    "Do not use lists, markdown, or emojis. Keep it natural and spoken. "
    "Always pick an emotion that fits your reply from: neutral, happy, angry, "
    "sad, relaxed."
)

# ---------------------------------------------------------------------------
# AWS clients (region pinned explicitly; boto3 doesn't always read AWS_REGION)
# ---------------------------------------------------------------------------
polly = boto3.client("polly", region_name=REGION)

_executor = ThreadPoolExecutor(max_workers=4)


# ---------------------------------------------------------------------------
# LangGraph agent (Nova Lite) with per-connection memory
# ---------------------------------------------------------------------------
class Reply(BaseModel):
    text: str
    emotion: Literal["neutral", "happy", "angry", "sad", "relaxed"]
    move: Literal["none", "dance"] = "none"


def _build_agent():
    """Build a LangGraph agent that returns a structured Reply with memory."""
    from langchain_aws import ChatBedrockConverse
    from langchain_core.messages import SystemMessage
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.graph import START, MessagesState, StateGraph

    llm = ChatBedrockConverse(
        model="us.amazon.nova-lite-v1:0",
        region_name=REGION,
        temperature=0.8,
        max_tokens=400,
    )
    structured = llm.with_structured_output(Reply)

    def call_model(state: MessagesState):
        # Keep the last ~20 messages for context.
        history = state["messages"][-20:]
        messages = [SystemMessage(content=SYSTEM_PROMPT)] + history
        reply: Reply = structured.invoke(messages)
        # Store the plain text back into memory as the assistant turn.
        from langchain_core.messages import AIMessage

        return {"messages": [AIMessage(content=reply.text)], "reply": reply}

    class State(MessagesState):
        reply: Reply | None

    graph = StateGraph(State)
    graph.add_node("model", call_model)
    graph.add_edge(START, "model")
    return graph.compile(checkpointer=InMemorySaver())


AGENT = _build_agent()


async def generate_reply(text: str, thread_id: str) -> Reply:
    """Run the agent for one user turn and return the structured reply."""
    from langchain_core.messages import HumanMessage

    config = {"configurable": {"thread_id": thread_id}}

    def _run() -> Reply:
        result = AGENT.invoke({"messages": [HumanMessage(content=text)]}, config)
        reply = result.get("reply")
        if reply is None:
            # Fallback: last message text, neutral emotion.
            last = result["messages"][-1].content
            return Reply(text=str(last), emotion="neutral")
        return reply

    return await asyncio.get_event_loop().run_in_executor(_executor, _run)


# ---------------------------------------------------------------------------
# Polly: synth mp3 + viseme/word speech marks in parallel
# ---------------------------------------------------------------------------
def _synth_audio(text: str) -> bytes:
    resp = polly.synthesize_speech(
        Text=text,
        OutputFormat="mp3",
        VoiceId=VOICE_ID,
        Engine=VOICE_ENGINE,
    )
    return resp["AudioStream"].read()


def _synth_marks(text: str) -> list[dict]:
    resp = polly.synthesize_speech(
        Text=text,
        OutputFormat="json",
        VoiceId=VOICE_ID,
        Engine=VOICE_ENGINE,
        SpeechMarkTypes=["viseme", "word"],
    )
    raw = resp["AudioStream"].read().decode("utf-8")
    marks = []
    for line in raw.splitlines():
        line = line.strip()
        if line:
            marks.append(json.loads(line))
    return marks


async def synthesize(text: str) -> tuple[str, list[dict]]:
    """Return (base64 mp3, list of speech marks). Two Polly calls in parallel."""
    loop = asyncio.get_event_loop()
    audio_fut = loop.run_in_executor(_executor, _synth_audio, text)
    marks_fut = loop.run_in_executor(_executor, _synth_marks, text)
    audio_bytes, marks = await asyncio.gather(audio_fut, marks_fut)
    return base64.b64encode(audio_bytes).decode("ascii"), marks


# ---------------------------------------------------------------------------
# Transcribe streaming (push-to-talk). One client reused.
# ---------------------------------------------------------------------------
class TranscribeSession:
    """Wraps a single Amazon Transcribe streaming session."""

    def __init__(self, ws: WebSocket, turn_id: int):
        self.ws = ws
        self.turn_id = turn_id
        self.stream = None
        self.handler_task = None
        self.client = None
        self.final_text = ""

    async def start(self):
        from amazon_transcribe.client import TranscribeStreamingClient
        from amazon_transcribe.handlers import TranscriptResultStreamHandler

        self.client = TranscribeStreamingClient(region=REGION)
        self.stream = await self.client.start_stream_transcription(
            language_code="en-US",
            media_sample_rate_hz=16000,
            media_encoding="pcm",
        )

        ws = self.ws
        turn_id = self.turn_id
        session = self

        class Handler(TranscriptResultStreamHandler):
            async def handle_transcript_event(self, transcript_event):
                for result in transcript_event.transcript.results:
                    if not result.alternatives:
                        continue
                    text = result.alternatives[0].transcript
                    if result.is_partial:
                        await ws.send_text(
                            json.dumps(
                                {"type": "partial", "turn": turn_id, "text": text}
                            )
                        )
                    else:
                        session.final_text = text

        self.handler = Handler(self.stream.output_stream)
        self.handler_task = asyncio.create_task(self.handler.handle_events())

    async def feed(self, pcm: bytes):
        if self.stream is not None:
            await self.stream.input_stream.send_audio_event(audio_chunk=pcm)

    async def stop(self) -> str:
        if self.stream is not None:
            await self.stream.input_stream.end_stream()
        if self.handler_task is not None:
            try:
                await asyncio.wait_for(self.handler_task, timeout=5)
            except asyncio.TimeoutError:
                pass
        return self.final_text


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI()


@app.get("/")
async def index():
    return FileResponse(PUBLIC / "index.html")


@app.get("/character")
async def character():
    """Public character info. Personality stays on the server."""
    return {
        "name": CHARACTER.get("name"),
        "avatar": CHARACTER.get("avatar"),
        "greeting": CHARACTER.get("greeting"),
        "background": CHARACTER.get("background", ["#222", "#444"]),
    }


async def _handle_user_text(ws: WebSocket, text: str, turn_id: int):
    """Generate a reply + speech and send it, tagged with the turn id."""
    text = (text or "").strip()[:500]
    if not text:
        return
    try:
        # Greeting is spoken verbatim (no LLM round-trip).
        if text.startswith("__greeting__:"):
            spoken = text[len("__greeting__:"):].strip() or "Hello!"
            reply = Reply(text=spoken, emotion="happy")
        else:
            reply = await generate_reply(text, thread_id=str(id(ws)))
        audio_b64, marks = await synthesize(reply.text)
        await ws.send_text(
            json.dumps(
                {
                    "type": "reply",
                    "turn": turn_id,
                    "text": reply.text,
                    "emotion": reply.emotion,
                    "move": reply.move,
                    "audio": audio_b64,
                    "marks": marks,
                }
            )
        )
    except Exception as exc:  # noqa: BLE001
        await ws.send_text(
            json.dumps(
                {
                    "type": "error",
                    "turn": turn_id,
                    "text": "Whoops, my coconut wifi dropped. Try me again?",
                    "detail": str(exc),
                }
            )
        )


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    transcribe: TranscribeSession | None = None
    try:
        while True:
            message = await ws.receive()
            if "bytes" in message and message["bytes"] is not None:
                # Binary PCM audio chunk for the active transcribe session.
                if transcribe is not None:
                    await transcribe.feed(message["bytes"])
                continue
            if "text" not in message or message["text"] is None:
                continue

            data = json.loads(message["text"])
            msg_type = data.get("type")

            if msg_type == "chat":
                await _handle_user_text(ws, data.get("text", ""), data.get("turn", 0))

            elif msg_type == "mic_start":
                transcribe = TranscribeSession(ws, data.get("turn", 0))
                await transcribe.start()

            elif msg_type == "mic_stop":
                if transcribe is not None:
                    final = await transcribe.stop()
                    turn_id = transcribe.turn_id
                    transcribe = None
                    if final.strip():
                        await ws.send_text(
                            json.dumps(
                                {"type": "final", "turn": turn_id, "text": final}
                            )
                        )
                        await _handle_user_text(ws, final, turn_id)
                    else:
                        await ws.send_text(
                            json.dumps(
                                {
                                    "type": "final",
                                    "turn": turn_id,
                                    "text": "",
                                }
                            )
                        )
    except WebSocketDisconnect:
        if transcribe is not None:
            try:
                await transcribe.stop()
            except Exception:  # noqa: BLE001
                pass


# Serve static assets (index.html, js, css, avatars, animations, music).
app.mount("/", StaticFiles(directory=str(PUBLIC), html=True), name="public")
