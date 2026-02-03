"""
Qwen3-TTS API Wrapper
This service wraps the Qwen3-TTS model and provides REST API endpoints
Run alongside your existing Gradio interface
"""

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
import torch
import torchaudio
import tempfile
import os
import logging
import gc
import threading

# Import Qwen3-TTS
from qwen_tts import Qwen3TTSModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Qwen3-TTS API")

# Global model instance
tts_model = None
model_kind = None
model_checkpoint = None
model_lock = threading.Lock()

MODEL_OPTIONS = {
    "base": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    "voice_design": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "custom_voice": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
}

DEFAULT_MODEL = "base"
DEVICE = "cuda:0"
DTYPE = torch.bfloat16
ATTN_IMPL = None  # or "flash_attention_2" if installed

def _clear_model():
    """Release model memory."""
    global tts_model, model_kind, model_checkpoint
    if tts_model is not None:
        del tts_model
        tts_model = None
        model_kind = None
        model_checkpoint = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

def _load_model(checkpoint: str):
    """Load a Qwen3-TTS model checkpoint."""
    global tts_model, model_kind, model_checkpoint
    with model_lock:
        _clear_model()
        logger.info(f"Loading model from {checkpoint}...")
        tts_model = Qwen3TTSModel.from_pretrained(
            checkpoint,
            device_map=DEVICE,
            dtype=DTYPE,
            attn_implementation=ATTN_IMPL
        )
        model_kind = getattr(tts_model.model, "tts_model_type", "base")
        model_checkpoint = checkpoint
        logger.info(f"Model loaded successfully! Type: {model_kind}")

def _normalize_audio(audio_data, sr):
    """Normalize audio from uploaded file"""
    import numpy as np
    if isinstance(audio_data, np.ndarray):
        audio_tensor = torch.from_numpy(audio_data).float()
    else:
        audio_tensor = audio_data
    
    if audio_tensor.dim() == 1:
        audio_tensor = audio_tensor.unsqueeze(0)
    elif audio_tensor.dim() == 2 and audio_tensor.shape[0] > 1:
        audio_tensor = torch.mean(audio_tensor, dim=0, keepdim=True)
    
    return audio_tensor, sr

def _to_audio_tensor(wav):
    """Ensure audio is a 2D torch tensor shaped [1, T]."""
    if isinstance(wav, torch.Tensor):
        tensor = wav
    else:
        tensor = torch.from_numpy(wav)

    if tensor.dim() == 1:
        tensor = tensor.unsqueeze(0)
    elif tensor.dim() == 2 and tensor.shape[0] > 1:
        tensor = torch.mean(tensor, dim=0, keepdim=True)
    return tensor.cpu()

@app.on_event("startup")
async def load_model():
    """Load the TTS model on startup"""
    checkpoint = MODEL_OPTIONS.get(DEFAULT_MODEL, DEFAULT_MODEL)
    _load_model(checkpoint)

# ============= Pydantic Models =============

class TTSRequest(BaseModel):
    text: str
    language: str = "Auto"
    max_new_tokens: int = 2048
    temperature: float = 0.9
    top_k: int = 50
    top_p: float = 1.0
    repetition_penalty: float = 1.05
    do_sample: bool = True
    subtalker_dosample: bool = True
    subtalker_temperature: float = 0.9
    subtalker_top_k: int = 50
    subtalker_top_p: float = 1.0

class VoiceDesignRequest(TTSRequest):
    instruct: str  # Voice description

class CustomVoiceRequest(TTSRequest):
    speaker: str = "Vivian"
    instruct: Optional[str] = None  # Emotion/style instruction

class ModelSwitchRequest(BaseModel):
    model: Optional[str] = None  # base | voice_design | custom_voice
    checkpoint: Optional[str] = None

# ============= API Endpoints =============

@app.get("/health")
async def health():
    """Health check"""
    return {
        "status": "healthy",
        "model_loaded": tts_model is not None,
        "model_type": model_kind
    }

@app.post("/api/voice-design")
async def voice_design(request: VoiceDesignRequest):
    """
    Generate speech with voice design description
    
    Example:
    {
        "text": "Hello world",
        "instruct": "Young energetic female voice with fast speaking rate",
        "language": "Auto"
    }
    """
    if tts_model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    if model_kind not in ["voice_design", "base"]:
        raise HTTPException(
            status_code=400,
            detail=f"Voice design not supported for {model_kind} model"
        )
    
    try:
        kwargs = {
            "max_new_tokens": request.max_new_tokens,
            "temperature": request.temperature,
            "top_k": request.top_k,
            "top_p": request.top_p,
            "repetition_penalty": request.repetition_penalty,
            "do_sample": request.do_sample,
            "subtalker_dosample": request.subtalker_dosample,
            "subtalker_temperature": request.subtalker_temperature,
            "subtalker_top_k": request.subtalker_top_k,
            "subtalker_top_p": request.subtalker_top_p,
        }
        
        with torch.no_grad():
            wavs, sr = tts_model.generate_voice_design(
                text=request.text,
                language=request.language,
                instruct=request.instruct,
                **kwargs
            )
        
        # Save to temporary file
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        audio_tensor = _to_audio_tensor(wavs[0])
        torchaudio.save(temp_file.name, audio_tensor, sr)
        temp_file.close()
        
        return FileResponse(
            temp_file.name,
            media_type="audio/wav",
            filename="voice_design.wav",
            background=lambda: os.unlink(temp_file.name)
        )
        
    except Exception as e:
        logger.error(f"Voice design error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/custom-voice")
async def custom_voice(request: CustomVoiceRequest):
    """
    Generate speech with preset speakers
    
    Example:
    {
        "text": "Hello world",
        "speaker": "Vivian",
        "instruct": "very happy tone",
        "language": "Auto"
    }
    """
    if tts_model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    if model_kind != "custom_voice":
        raise HTTPException(
            status_code=400,
            detail=f"Custom voice not supported for {model_kind} model"
        )
    
    try:
        kwargs = {
            "max_new_tokens": request.max_new_tokens,
            "temperature": request.temperature,
            "top_k": request.top_k,
            "top_p": request.top_p,
            "repetition_penalty": request.repetition_penalty,
            "do_sample": request.do_sample,
            "subtalker_dosample": request.subtalker_dosample,
            "subtalker_temperature": request.subtalker_temperature,
            "subtalker_top_k": request.subtalker_top_k,
            "subtalker_top_p": request.subtalker_top_p,
        }
        
        with torch.no_grad():
            wavs, sr = tts_model.generate_custom_voice(
                text=request.text,
                language=request.language,
                speaker=request.speaker,
                instruct=request.instruct,
                **kwargs
            )
        
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        audio_tensor = _to_audio_tensor(wavs[0])
        torchaudio.save(temp_file.name, audio_tensor, sr)
        temp_file.close()
        
        return FileResponse(
            temp_file.name,
            media_type="audio/wav",
            filename="custom_voice.wav",
            background=lambda: os.unlink(temp_file.name)
        )
        
    except Exception as e:
        logger.error(f"Custom voice error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/voice-clone")
async def voice_clone(
    text: str = Form(...),
    language: str = Form("Auto"),
    ref_audio: UploadFile = File(...),
    ref_text: Optional[str] = Form(None),
    x_vector_only: bool = Form(False),
    max_new_tokens: int = Form(2048),
    temperature: float = Form(0.9),
    top_k: int = Form(50),
    top_p: float = Form(1.0),
    repetition_penalty: float = Form(1.05),
    do_sample: bool = Form(True),
    subtalker_dosample: bool = Form(True),
    subtalker_temperature: float = Form(0.9),
    subtalker_top_k: int = Form(50),
    subtalker_top_p: float = Form(1.0)
):
    """
    Clone voice from reference audio
    
    Upload reference audio file and provide transcript (unless x_vector_only=true)
    """
    if tts_model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    if model_kind != "base":
        raise HTTPException(
            status_code=400,
            detail=f"Voice cloning not supported for {model_kind} model"
        )
    
    try:
        # Save uploaded audio
        temp_audio = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        content = await ref_audio.read()
        temp_audio.write(content)
        temp_audio.close()
        
        # Load and process audio
        waveform, sample_rate = torchaudio.load(temp_audio.name)
        
        # Resample if needed
        if sample_rate != 12000:
            waveform = torchaudio.functional.resample(waveform, sample_rate, 12000)
            sample_rate = 12000
        
        # Ensure mono
        if waveform.shape[0] > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)
        
        ref_audio_tuple = (waveform[0].numpy(), sample_rate)
        
        kwargs = {
            "max_new_tokens": max_new_tokens,
            "temperature": temperature,
            "top_k": top_k,
            "top_p": top_p,
            "repetition_penalty": repetition_penalty,
            "do_sample": do_sample,
            "subtalker_dosample": subtalker_dosample,
            "subtalker_temperature": subtalker_temperature,
            "subtalker_top_k": subtalker_top_k,
            "subtalker_top_p": subtalker_top_p,
        }
        
        with torch.no_grad():
            wavs, sr = tts_model.generate_voice_clone(
                text=text,
                language=language,
                ref_audio=ref_audio_tuple,
                ref_text=ref_text if ref_text else None,
                x_vector_only_mode=x_vector_only,
                **kwargs
            )
        
        # Clean up uploaded file
        os.unlink(temp_audio.name)
        
        # Save output
        temp_output = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        audio_tensor = _to_audio_tensor(wavs[0])
        torchaudio.save(temp_output.name, audio_tensor, sr)
        temp_output.close()
        
        return FileResponse(
            temp_output.name,
            media_type="audio/wav",
            filename="voice_clone.wav",
            background=lambda: os.unlink(temp_output.name)
        )
        
    except Exception as e:
        logger.error(f"Voice clone error: {e}")
        # Clean up temp files
        try:
            if 'temp_audio' in locals():
                os.unlink(temp_audio.name)
        except:
            pass
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/info")
async def get_info():
    """Get model information and capabilities"""
    if tts_model is None:
        return {"status": "Model not loaded"}
    
    supported_langs = None
    supported_speakers = None
    
    if callable(getattr(tts_model.model, "get_supported_languages", None)):
        supported_langs = tts_model.model.get_supported_languages()
    
    if callable(getattr(tts_model.model, "get_supported_speakers", None)):
        supported_speakers = tts_model.model.get_supported_speakers()
    
    return {
        "model_checkpoint": model_checkpoint,
        "model_type": model_kind,
        "supported_languages": supported_langs,
        "supported_speakers": supported_speakers,
        "sample_rate": 12000,
        "available_models": list(MODEL_OPTIONS.keys()),
        "endpoints": {
            "voice_design": "/api/voice-design" if model_kind in ["voice_design", "base"] else None,
            "custom_voice": "/api/custom-voice" if model_kind == "custom_voice" else None,
            "voice_clone": "/api/voice-clone" if model_kind == "base" else None
        }
    }

@app.post("/api/load-model")
async def load_model_endpoint(request: ModelSwitchRequest):
    """Load a different TTS model checkpoint."""
    model_key = (request.model or "").strip().lower()
    checkpoint = request.checkpoint or MODEL_OPTIONS.get(model_key)
    if not checkpoint:
        raise HTTPException(status_code=400, detail="Unknown model or checkpoint")

    try:
        _load_model(checkpoint)
        return {
            "status": "ok",
            "model_type": model_kind,
            "model_checkpoint": model_checkpoint
        }
    except Exception as e:
        logger.error(f"Model load error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=9001,  # Different port from Gradio (9000)
        log_level="info"
    )
