from fastapi import FastAPI, UploadFile, File, Form, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel
from typing import Optional, List
import httpx
import logging
import websockets
import asyncio
import tempfile
import os

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Services Gateway")

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://nomability.net", "https://api.nomability.net"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Service endpoints (adjust ports as needed)
SERVICES = {
    "fastwhisper": "http://localhost:8008",
    "ollama": "http://localhost:11434",
    "qwen_ocr": "http://localhost:8080",
    "whisperlive": "ws://localhost:9090",
    "qwen_tts": "http://localhost:9001"  # Qwen3-TTS API wrapper
}

# ============= Pydantic Models for TTS =============

class TTSVoiceCloneRequest(BaseModel):
    text: str
    language: Optional[str] = "Auto"
    ref_text: Optional[str] = None
    x_vector_only: bool = False
    max_new_tokens: Optional[int] = 2048
    temperature: Optional[float] = 0.9
    top_k: Optional[int] = 50
    top_p: Optional[float] = 1.0
    repetition_penalty: Optional[float] = 1.05
    do_sample: bool = True
    subtalker_dosample: bool = True
    subtalker_temperature: Optional[float] = 0.9
    subtalker_top_k: Optional[int] = 50
    subtalker_top_p: Optional[float] = 1.0

class TTSVoiceDesignRequest(BaseModel):
    text: str
    language: Optional[str] = "Auto"
    instruct: str  # Voice design instruction
    max_new_tokens: Optional[int] = 2048
    temperature: Optional[float] = 0.9
    top_k: Optional[int] = 50
    top_p: Optional[float] = 1.0
    repetition_penalty: Optional[float] = 1.05
    do_sample: bool = True
    subtalker_dosample: bool = True
    subtalker_temperature: Optional[float] = 0.9
    subtalker_top_k: Optional[int] = 50
    subtalker_top_p: Optional[float] = 1.0

class TTSCustomVoiceRequest(BaseModel):
    text: str
    language: str = "Auto"
    speaker: str = "Vivian"
    instruct: Optional[str] = None
    max_new_tokens: Optional[int] = 2048
    temperature: Optional[float] = 0.9
    top_k: Optional[int] = 50
    top_p: Optional[float] = 1.0
    repetition_penalty: Optional[float] = 1.05
    do_sample: bool = True
    subtalker_dosample: bool = True
    subtalker_temperature: Optional[float] = 0.9
    subtalker_top_k: Optional[int] = 50
    subtalker_top_p: Optional[float] = 1.0

# ============= Health Check =============

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "services": list(SERVICES.keys())}

# ============= FastWhisper Endpoints =============

@app.post("/v1/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: Optional[str] = Form("base"),
    language: Optional[str] = Form(None),
    stream: Optional[bool] = Form(False)
):
    """Proxy to FastWhisper API"""
    try:
        files = {"file": (file.filename, await file.read(), file.content_type)}
        data = {"model": model}
        if language:
            data["language"] = language
        
        params = {"stream": "true"} if stream else {}
        
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{SERVICES['fastwhisper']}/v1/transcriptions",
                files=files,
                data=data,
                params=params
            )
            
            if stream:
                return StreamingResponse(
                    response.iter_bytes(),
                    media_type="text/event-stream"
                )
            
            return response.json()
            
    except Exception as e:
        logger.error(f"FastWhisper error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============= Ollama Endpoints =============

@app.post("/ollama/api/generate")
async def ollama_generate(payload: dict):
    """Proxy to Ollama generate endpoint"""
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{SERVICES['ollama']}/api/generate",
                json=payload
            )
            return response.json()
    except Exception as e:
        logger.error(f"Ollama error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/ollama/api/chat")
async def ollama_chat(payload: dict):
    """Proxy to Ollama chat endpoint"""
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{SERVICES['ollama']}/api/chat",
                json=payload
            )
            return response.json()
    except Exception as e:
        logger.error(f"Ollama error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============= Qwen OCR Endpoints =============

@app.post("/ocr")
async def qwen_ocr(file: UploadFile = File(...)):
    """Proxy to Qwen OCR"""
    try:
        files = {"file": (file.filename, await file.read(), file.content_type)}
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{SERVICES['qwen_ocr']}/ocr",
                files=files
            )
            return response.json()
    except Exception as e:
        logger.error(f"OCR error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============= Qwen3-TTS Endpoints =============

@app.post("/tts/voice-clone")
async def tts_voice_clone(
    text: str = Form(...),
    language: str = Form("Auto"),
    ref_audio: UploadFile = File(...),
    ref_text: Optional[str] = Form(None),
    x_vector_only: bool = Form(False),
    max_new_tokens: int = Form(2048),
    temperature: float = Form(0.9),
    top_k: int = Form(50),
    top_p: float = Form(1.0),
    repetition_penalty: float = Form(1.05)
):
    """
    Voice cloning with reference audio (for Base model)
    
    Upload a reference audio file and provide its transcript (unless using x_vector_only mode)
    """
    try:
        # Prepare multipart form data
        files = {
            'ref_audio': (ref_audio.filename, await ref_audio.read(), ref_audio.content_type)
        }
        
        data = {
            'text': text,
            'language': language,
            'ref_text': ref_text or '',
            'x_vector_only': x_vector_only,
            'max_new_tokens': max_new_tokens,
            'temperature': temperature,
            'top_k': top_k,
            'top_p': top_p,
            'repetition_penalty': repetition_penalty
        }
        
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{SERVICES['qwen_tts']}/api/voice-clone",
                files=files,
                data=data
            )
            
            if response.status_code == 200:
                return StreamingResponse(
                    iter([response.content]),
                    media_type="audio/wav",
                    headers={"Content-Disposition": "attachment; filename=voice_clone.wav"}
                )
            else:
                raise HTTPException(status_code=response.status_code, detail=response.text)
                
    except Exception as e:
        logger.error(f"TTS Voice Clone error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/tts/voice-design")
async def tts_voice_design(request: TTSVoiceDesignRequest):
    """
    Generate speech with voice design description (for VoiceDesign model)
    
    Describe the desired voice characteristics in detail
    """
    try:
        payload = {
            "text": request.text,
            "language": request.language,
            "instruct": request.instruct,
            "max_new_tokens": request.max_new_tokens,
            "temperature": request.temperature,
            "top_k": request.top_k,
            "top_p": request.top_p,
            "repetition_penalty": request.repetition_penalty,
            "do_sample": request.do_sample,
            "subtalker_dosample": request.subtalker_dosample,
            "subtalker_temperature": request.subtalker_temperature,
            "subtalker_top_k": request.subtalker_top_k,
            "subtalker_top_p": request.subtalker_top_p
        }
        
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{SERVICES['qwen_tts']}/api/voice-design",
                json=payload
            )
            
            if response.status_code == 200:
                return StreamingResponse(
                    iter([response.content]),
                    media_type="audio/wav",
                    headers={"Content-Disposition": "attachment; filename=voice_design.wav"}
                )
            else:
                logger.error(f"TTS API error: {response.status_code} - {response.text}")
                raise HTTPException(status_code=response.status_code, detail=response.text)
                
    except httpx.TimeoutException:
        logger.error("TTS request timeout")
        raise HTTPException(status_code=504, detail="TTS generation timeout")
    except Exception as e:
        logger.error(f"TTS Voice Design error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/tts/custom-voice")
async def tts_custom_voice(request: TTSCustomVoiceRequest):
    """
    Generate speech with preset speakers and emotion control (for CustomVoice model)
    
    Available speakers: Vivian, Ryan, etc.
    Use 'instruct' field for emotion/style: "very happy", "angry tone", etc.
    """
    try:
        payload = {
            "text": request.text,
            "language": request.language,
            "speaker": request.speaker,
            "instruct": request.instruct,
            "max_new_tokens": request.max_new_tokens,
            "temperature": request.temperature,
            "top_k": request.top_k,
            "top_p": request.top_p,
            "repetition_penalty": request.repetition_penalty,
            "do_sample": request.do_sample,
            "subtalker_dosample": request.subtalker_dosample,
            "subtalker_temperature": request.subtalker_temperature,
            "subtalker_top_k": request.subtalker_top_k,
            "subtalker_top_p": request.subtalker_top_p
        }
        
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{SERVICES['qwen_tts']}/api/custom-voice",
                json=payload
            )
            
            if response.status_code == 200:
                return StreamingResponse(
                    iter([response.content]),
                    media_type="audio/wav",
                    headers={"Content-Disposition": "attachment; filename=custom_voice.wav"}
                )
            else:
                raise HTTPException(status_code=response.status_code, detail=response.text)
                
    except Exception as e:
        logger.error(f"TTS Custom Voice error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/tts/simple")
async def tts_simple(
    text: str = Form(...),
    voice_description: Optional[str] = Form("Professional female voice, clear and articulate")
):
    """
    Simplified TTS endpoint - just text and voice description
    
    Example voice descriptions:
    - "Young energetic female with fast speaking rate"
    - "Deep authoritative male voice, slow and deliberate"
    - "Friendly conversational tone, middle-aged woman"
    """
    try:
        payload = {
            "text": text,
            "language": "Auto",
            "instruct": voice_description,
            "max_new_tokens": 2048,
            "temperature": 0.9,
            "top_k": 50,
            "top_p": 1.0,
            "repetition_penalty": 1.05,
            "do_sample": True,
            "subtalker_dosample": True,
            "subtalker_temperature": 0.9,
            "subtalker_top_k": 50,
            "subtalker_top_p": 1.0
        }
        
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{SERVICES['qwen_tts']}/api/voice-design",
                json=payload
            )
            
            if response.status_code == 200:
                return StreamingResponse(
                    iter([response.content]),
                    media_type="audio/wav",
                    headers={"Content-Disposition": "attachment; filename=speech.wav"}
                )
            else:
                logger.error(f"TTS API returned {response.status_code}: {response.text}")
                raise HTTPException(status_code=response.status_code, detail=response.text)
                
    except httpx.TimeoutException:
        logger.error("TTS request timeout")
        raise HTTPException(status_code=504, detail="TTS generation timeout - text may be too long")
    except Exception as e:
        logger.error(f"TTS Simple error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============= TTS Info Endpoint =============

@app.get("/tts/info")
async def tts_info():
    """Get information about available TTS models and capabilities"""
    base_info = {
        "service": "Qwen3-TTS",
        "models": {
            "voice_clone": {
                "description": "Clone any voice from a reference audio sample",
                "endpoint": "/tts/voice-clone",
                "requires_audio": True,
                "parameters": ["text", "ref_audio", "ref_text", "language", "x_vector_only"]
            },
            "voice_design": {
                "description": "Create custom voices from text descriptions",
                "endpoint": "/tts/voice-design",
                "requires_audio": False,
                "parameters": ["text", "instruct", "language"]
            },
            "custom_voice": {
                "description": "Use preset speakers with emotion control",
                "endpoint": "/tts/custom-voice",
                "requires_audio": False,
                "parameters": ["text", "speaker", "instruct", "language"],
                "available_speakers": ["Vivian", "Ryan"]
            },
            "simple": {
                "description": "Simplified TTS with just text and voice description",
                "endpoint": "/tts/simple",
                "requires_audio": False,
                "parameters": ["text", "voice_description"]
            }
        },
        "advanced_parameters": {
            "max_new_tokens": "512-8192, controls output length",
            "temperature": "0.1-2.0, controls randomness",
            "top_k": "1-200, limits token selection",
            "top_p": "0.0-1.0, nucleus sampling threshold",
            "repetition_penalty": "1.0-2.0, reduces repetition",
            "subtalker parameters": "Control fine acoustic details"
        },
        "supported_languages": ["Auto", "English", "Chinese", "Japanese", "Korean", "Spanish", "French", "German"]
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(f"{SERVICES['qwen_tts']}/api/info")
            if response.status_code == 200:
                upstream = response.json()
                base_info["current_model_type"] = upstream.get("model_type")
                base_info["current_model_checkpoint"] = upstream.get("model_checkpoint")
                if upstream.get("supported_languages"):
                    base_info["supported_languages"] = upstream.get("supported_languages")
                if upstream.get("supported_speakers"):
                    base_info["models"]["custom_voice"]["available_speakers"] = upstream.get("supported_speakers")
    except Exception as e:
        logger.error(f"TTS info upstream error: {e}")

    return base_info

@app.post("/tts/load-model")
async def tts_load_model(payload: dict):
    """Load a different Qwen3-TTS model checkpoint."""
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            response = await client.post(
                f"{SERVICES['qwen_tts']}/api/load-model",
                json=payload
            )
            if response.status_code == 200:
                return response.json()
            raise HTTPException(status_code=response.status_code, detail=response.text)
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Model load timeout")
    except Exception as e:
        logger.error(f"TTS load model error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============= WhisperLive WebSocket =============

@app.websocket("/ws/whisperlive")
async def whisperlive_websocket(websocket: WebSocket):
    """Proxy WebSocket connections to WhisperLive"""
    await websocket.accept()
    
    whisperlive_url = SERVICES['whisperlive'].replace('ws://', 'ws://')
    
    try:
        async with websockets.connect(whisperlive_url) as ws_backend:
            async def forward_to_backend():
                try:
                    while True:
                        data = await websocket.receive()
                        if "text" in data:
                            await ws_backend.send(data["text"])
                        elif "bytes" in data:
                            await ws_backend.send(data["bytes"])
                except WebSocketDisconnect:
                    logger.info("Client disconnected")
                except Exception as e:
                    logger.error(f"Error forwarding to backend: {e}")
            
            async def forward_to_client():
                try:
                    async for message in ws_backend:
                        if isinstance(message, str):
                            await websocket.send_text(message)
                        else:
                            await websocket.send_bytes(message)
                except WebSocketDisconnect:
                    logger.info("Client disconnected")
                except Exception as e:
                    logger.error(f"Error forwarding to client: {e}")
            
            await asyncio.gather(
                forward_to_backend(),
                forward_to_client(),
                return_exceptions=True
            )
            
    except Exception as e:
        logger.error(f"WhisperLive WebSocket error: {e}")
        await websocket.close(code=1011, reason=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=9072,
        log_level="info"
    )
