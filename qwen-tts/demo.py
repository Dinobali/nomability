# coding=utf-8
# Copyright 2026 The Alibaba Qwen team.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""
Enhanced gradio demo for Qwen3 TTS models with full parameter control.
"""

import argparse
import gc
import os
import tempfile
import threading
from contextlib import contextmanager
from dataclasses import asdict
from typing import Any, Dict, List, Optional, Tuple

import gradio as gr
import numpy as np
import torch

from .. import Qwen3TTSModel, VoiceClonePromptItem


def _title_case_display(s: str) -> str:
    s = (s or "").strip()
    s = s.replace("_", " ")
    return " ".join([w[:1].upper() + w[1:] if w else "" for w in s.split()])


def _build_choices_and_map(items: Optional[List[str]]) -> Tuple[List[str], Dict[str, str]]:
    if not items:
        return [], {}
    display = [_title_case_display(x) for x in items]
    mapping = {d: r for d, r in zip(display, items)}
    return display, mapping


def _dtype_from_str(s: str) -> torch.dtype:
    s = (s or "").strip().lower()
    if s in ("bf16", "bfloat16"):
        return torch.bfloat16
    if s in ("fp16", "float16", "half"):
        return torch.float16
    if s in ("fp32", "float32"):
        return torch.float32
    raise ValueError(f"Unsupported torch dtype: {s}. Use bfloat16/float16/float32.")


def _maybe(v):
    return v if v is not None else gr.update()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="qwen-tts-demo",
        description=(
            "Launch a Gradio demo for Qwen3 TTS models (CustomVoice / VoiceDesign / Base).\n\n"
            "Examples:\n"
            "  qwen-tts-demo Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice\n"
            "  qwen-tts-demo Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign --port 9000 --ip 127.0.0.01\n"
            "  qwen-tts-demo Qwen/Qwen3-TTS-12Hz-1.7B-Base --device cuda:0\n"
            "  qwen-tts-demo Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --dtype bfloat16 --no-flash-attn\n"
        ),
        formatter_class=argparse.RawTextHelpFormatter,
        add_help=True,
    )

    # Positional checkpoint (also supports -c/--checkpoint)
    parser.add_argument(
        "checkpoint_pos",
        nargs="?",
        default=None,
        help="Model checkpoint path or HuggingFace repo id (positional).",
    )
    parser.add_argument(
        "-c",
        "--checkpoint",
        default=None,
        help="Model checkpoint path or HuggingFace repo id (optional if positional is provided).",
    )

    # Model loading / from_pretrained args
    parser.add_argument(
        "--device",
        default="cuda:0",
        help="Device for device_map, e.g. cpu, cuda, cuda:0 (default: cuda:0).",
    )
    parser.add_argument(
        "--dtype",
        default="bfloat16",
        choices=["bfloat16", "bf16", "float16", "fp16", "float32", "fp32"],
        help="Torch dtype for loading the model (default: bfloat16).",
    )
    parser.add_argument(
        "--flash-attn/--no-flash-attn",
        dest="flash_attn",
        default=True,
        action=argparse.BooleanOptionalAction,
        help="Enable FlashAttention-2 (default: enabled).",
    )

    # Gradio server args
    parser.add_argument(
        "--ip",
        default="0.0.0.0",
        help="Server bind IP for Gradio (default: 0.0.0.0).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=9000,
        help="Server port for Gradio (default: 9000).",
    )
    parser.add_argument(
        "--share/--no-share",
        dest="share",
        default=False,
        action=argparse.BooleanOptionalAction,
        help="Whether to create a public Gradio link (default: disabled).",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=16,
        help="Gradio queue concurrency (default: 16).",
    )

    # HTTPS args
    parser.add_argument(
        "--ssl-certfile",
        default=None,
        help="Path to SSL certificate file for HTTPS (optional).",
    )
    parser.add_argument(
        "--ssl-keyfile",
        default=None,
        help="Path to SSL key file for HTTPS (optional).",
    )
    parser.add_argument(
        "--ssl-verify/--no-ssl-verify",
        dest="ssl_verify",
        default=True,
        action=argparse.BooleanOptionalAction,
        help="Whether to verify SSL certificate (default: enabled).",
    )

    # Optional generation args
    parser.add_argument("--max-new-tokens", type=int, default=None, help="Max new tokens for generation (optional).")
    parser.add_argument("--temperature", type=float, default=None, help="Sampling temperature (optional).")
    parser.add_argument("--top-k", type=int, default=None, help="Top-k sampling (optional).")
    parser.add_argument("--top-p", type=float, default=None, help="Top-p sampling (optional).")
    parser.add_argument("--repetition-penalty", type=float, default=None, help="Repetition penalty (optional).")
    parser.add_argument("--subtalker-top-k", type=int, default=None, help="Subtalker top-k (optional, only for tokenizer v2).")
    parser.add_argument("--subtalker-top-p", type=float, default=None, help="Subtalker top-p (optional, only for tokenizer v2).")
    parser.add_argument(
        "--subtalker-temperature", type=float, default=None, help="Subtalker temperature (optional, only for tokenizer v2)."
    )

    return parser


def _resolve_checkpoint(args: argparse.Namespace) -> str:
    ckpt = args.checkpoint or args.checkpoint_pos
    if not ckpt:
        raise SystemExit(0)  # main() prints help
    return ckpt


def _collect_gen_kwargs(args: argparse.Namespace) -> Dict[str, Any]:
    mapping = {
        "max_new_tokens": args.max_new_tokens,
        "temperature": args.temperature,
        "top_k": args.top_k,
        "top_p": args.top_p,
        "repetition_penalty": args.repetition_penalty,
        "subtalker_top_k": args.subtalker_top_k,
        "subtalker_top_p": args.subtalker_top_p,
        "subtalker_temperature": args.subtalker_temperature,
    }
    return {k: v for k, v in mapping.items() if v is not None}


def _normalize_audio(wav, eps=1e-12, clip=True):
    x = np.asarray(wav)

    if np.issubdtype(x.dtype, np.integer):
        info = np.iinfo(x.dtype)

        if info.min < 0:
            y = x.astype(np.float32) / max(abs(info.min), info.max)
        else:
            mid = (info.max + 1) / 2.0
            y = (x.astype(np.float32) - mid) / mid

    elif np.issubdtype(x.dtype, np.floating):
        y = x.astype(np.float32)
        m = np.max(np.abs(y)) if y.size else 0.0

        if m <= 1.0 + 1e-6:
            pass
        else:
            y = y / (m + eps)
    else:
        raise TypeError(f"Unsupported dtype: {x.dtype}")

    if clip:
        y = np.clip(y, -1.0, 1.0)
    
    if y.ndim > 1:
        y = np.mean(y, axis=-1).astype(np.float32)

    return y


def _audio_to_tuple(audio: Any) -> Optional[Tuple[np.ndarray, int]]:
    if audio is None:
        return None

    if isinstance(audio, tuple) and len(audio) == 2 and isinstance(audio[0], int):
        sr, wav = audio
        wav = _normalize_audio(wav)
        return wav, int(sr)

    if isinstance(audio, dict) and "sampling_rate" in audio and "data" in audio:
        sr = int(audio["sampling_rate"])
        wav = _normalize_audio(audio["data"])
        return wav, sr

    return None


def _wav_to_gradio_audio(wav: np.ndarray, sr: int) -> Tuple[int, np.ndarray]:
    wav = np.asarray(wav, dtype=np.float32)
    return sr, wav


def _detect_model_kind(ckpt: str, tts: Qwen3TTSModel) -> str:
    mt = getattr(tts.model, "tts_model_type", None)
    if mt in ("custom_voice", "voice_design", "base"):
        return mt
    else:
        raise ValueError(f"Unknown Qwen-TTS model type: {mt}")


MODEL_PRESETS = [
    "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
]

_STATE_LOCK = threading.Lock()
_STATE_COND = threading.Condition(_STATE_LOCK)
_MODEL_STATE: Dict[str, Any] = {
    "tts": None,
    "ckpt": "",
    "model_kind": "",
    "lang_choices_disp": [],
    "lang_choices_ui": [],
    "lang_map": {},
    "spk_choices_disp": [],
    "spk_map": {},
    "active_jobs": 0,
    "reloading": False,
}


def _default_lang_value(choices: List[str]) -> Optional[str]:
    if "Auto" in choices:
        return "Auto"
    return choices[0] if choices else None


def _default_spk_value(choices: List[str]) -> Optional[str]:
    if not choices:
        return None
    if "Vivian" in choices:
        return "Vivian"
    return choices[0]


def _format_header(ckpt: str, model_kind: str) -> str:
    return f"""
# 🎙️ Qwen3 TTS Demo - Enhanced Edition
**Checkpoint:** `{ckpt}`  
**Model Type:** `{model_kind}`  

Full control over all generation parameters including sampling, subtalker controls, and advanced options.
"""


def _format_model_info(lang_choices_disp: List[str], spk_choices_disp: List[str]) -> str:
    langs = lang_choices_disp if lang_choices_disp else ["Auto"]
    spks = spk_choices_disp if spk_choices_disp else ["N/A"]
    return (
        """
---
### 📊 Model Information

**Supported Languages**: """
        + ", ".join(langs)
        + """

**Supported Speakers** (CustomVoice): """
        + ", ".join(spks)
        + """

**Sample Rate**: 12kHz

---

**Built with** ❤️ **using Qwen3-TTS** | [Documentation](https://github.com/QwenLM/Qwen3-TTS) | [Blog Post](https://qwen.ai/blog?id=qwen3tts-0115)
"""
    )


def _build_model_state(tts: Qwen3TTSModel, ckpt: str) -> Dict[str, Any]:
    model_kind = _detect_model_kind(ckpt, tts)

    supported_langs_raw = None
    if callable(getattr(tts.model, "get_supported_languages", None)):
        supported_langs_raw = tts.model.get_supported_languages()

    supported_spks_raw = None
    if callable(getattr(tts.model, "get_supported_speakers", None)):
        supported_spks_raw = tts.model.get_supported_speakers()

    lang_choices_disp, lang_map = _build_choices_and_map([x for x in (supported_langs_raw or [])])
    spk_choices_disp, spk_map = _build_choices_and_map([x for x in (supported_spks_raw or [])])

    lang_choices_ui = lang_choices_disp[:]
    if "Auto" not in lang_choices_ui:
        lang_choices_ui.insert(0, "Auto")
    lang_map = {"Auto": "Auto", **lang_map}

    return {
        "tts": tts,
        "ckpt": ckpt,
        "model_kind": model_kind,
        "lang_choices_disp": lang_choices_disp,
        "lang_choices_ui": lang_choices_ui,
        "lang_map": lang_map,
        "spk_choices_disp": spk_choices_disp,
        "spk_map": spk_map,
    }


def _set_model_state(state: Dict[str, Any]) -> None:
    with _STATE_COND:
        _MODEL_STATE.update(state)


def _cleanup_memory() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        if hasattr(torch.cuda, "ipc_collect"):
            torch.cuda.ipc_collect()


@contextmanager
def _use_model() -> Dict[str, Any]:
    with _STATE_COND:
        while _MODEL_STATE["reloading"]:
            _STATE_COND.wait()
        _MODEL_STATE["active_jobs"] += 1
        state = {
            "tts": _MODEL_STATE["tts"],
            "ckpt": _MODEL_STATE["ckpt"],
            "model_kind": _MODEL_STATE["model_kind"],
            "lang_map": _MODEL_STATE["lang_map"],
            "spk_map": _MODEL_STATE["spk_map"],
        }
    try:
        yield state
    finally:
        with _STATE_COND:
            _MODEL_STATE["active_jobs"] -= 1
            if _MODEL_STATE["active_jobs"] <= 0:
                _STATE_COND.notify_all()


def _reload_model(
    ckpt: str,
    device: str,
    dtype: torch.dtype,
    attn_impl: Optional[str],
) -> Dict[str, Any]:
    ckpt = (ckpt or "").strip()
    if not ckpt:
        raise ValueError("Checkpoint is required.")

    with _STATE_COND:
        _MODEL_STATE["reloading"] = True
        while _MODEL_STATE["active_jobs"] > 0:
            _STATE_COND.wait()
        old_tts = _MODEL_STATE.get("tts")
        _MODEL_STATE.update(
            {
                "tts": None,
                "ckpt": "",
                "model_kind": "",
                "lang_choices_disp": [],
                "lang_choices_ui": [],
                "lang_map": {},
                "spk_choices_disp": [],
                "spk_map": {},
            }
        )

    try:
        if old_tts is not None:
            del old_tts
        _cleanup_memory()
        tts = Qwen3TTSModel.from_pretrained(
            ckpt,
            device_map=device,
            dtype=dtype,
            attn_implementation=attn_impl,
        )
        state = _build_model_state(tts, ckpt)
        _set_model_state(state)
    except Exception:
        with _STATE_COND:
            _MODEL_STATE["reloading"] = False
            _STATE_COND.notify_all()
        raise

    with _STATE_COND:
        _MODEL_STATE["reloading"] = False
        _STATE_COND.notify_all()
    return state


def build_demo(
    state: Dict[str, Any],
    gen_kwargs_default: Dict[str, Any],
    device: str,
    dtype: torch.dtype,
    attn_impl: Optional[str],
) -> gr.Blocks:
    ckpt = state["ckpt"]
    model_kind = state["model_kind"]
    lang_choices_ui = state["lang_choices_ui"]
    spk_choices_disp = state["spk_choices_disp"]

    # Default values for advanced parameters
    default_max_tokens = gen_kwargs_default.get("max_new_tokens", 2048)
    default_temperature = gen_kwargs_default.get("temperature", 0.9)
    default_top_k = gen_kwargs_default.get("top_k", 50)
    default_top_p = gen_kwargs_default.get("top_p", 1.0)
    default_rep_penalty = gen_kwargs_default.get("repetition_penalty", 1.05)
    default_subtalker_temp = gen_kwargs_default.get("subtalker_temperature", 0.9)
    default_subtalker_top_k = gen_kwargs_default.get("subtalker_top_k", 50)
    default_subtalker_top_p = gen_kwargs_default.get("subtalker_top_p", 1.0)
    default_lang_value = _default_lang_value(lang_choices_ui)
    default_spk_value = _default_spk_value(spk_choices_disp)

    def _gen_common_kwargs(
        max_tokens, temp, top_k, top_p, rep_pen, 
        do_sample, subtalker_dosample, subtalker_temp, subtalker_top_k, subtalker_top_p
    ) -> Dict[str, Any]:
        return {
            "max_new_tokens": int(max_tokens),
            "temperature": float(temp),
            "top_k": int(top_k),
            "top_p": float(top_p),
            "repetition_penalty": float(rep_pen),
            "do_sample": bool(do_sample),
            "subtalker_dosample": bool(subtalker_dosample),
            "subtalker_temperature": float(subtalker_temp),
            "subtalker_top_k": int(subtalker_top_k),
            "subtalker_top_p": float(subtalker_top_p),
        }

    theme = gr.themes.Soft(
        font=[gr.themes.GoogleFont("Source Sans Pro"), "Arial", "sans-serif"],
    )

    css = """
    .gradio-container {max-width: none !important;}
    .advanced-params {background-color: rgba(0,0,0,0.02); padding: 15px; border-radius: 8px;}
    """

    with gr.Blocks() as demo:
        header_md = gr.Markdown(_format_header(ckpt, model_kind))

        with gr.Accordion("🧠 Model Switcher", open=False):
            gr.Markdown("Unload the current model and load a new checkpoint (may take a while).")
            ckpt_in = gr.Dropdown(
                label="Checkpoint",
                choices=MODEL_PRESETS,
                value=ckpt,
                interactive=True,
            )
            load_btn = gr.Button("🔄 Load Model", variant="primary")
            load_status = gr.Textbox(label="Status", lines=2, interactive=False)

        # Advanced parameters section (shared across all tabs)
        with gr.Accordion("⚙️ Advanced Generation Parameters", open=False):
            gr.Markdown("### Main Sampling Parameters")
            with gr.Row():
                max_new_tokens = gr.Slider(
                    512, 8192, value=default_max_tokens, step=256,
                    label="Max New Tokens"
                )
                do_sample = gr.Checkbox(
                    value=True,
                    label="Enable Sampling"
                )
            
            with gr.Row():
                temperature = gr.Slider(
                    0.1, 2.0, value=default_temperature, step=0.05,
                    label="Temperature"
                )
                top_p = gr.Slider(
                    0.0, 1.0, value=default_top_p, step=0.05,
                    label="Top-p (Nucleus Sampling)"
                )
            
            with gr.Row():
                top_k = gr.Slider(
                    1, 200, value=default_top_k, step=1,
                    label="Top-k"
                )
                repetition_penalty = gr.Slider(
                    1.0, 2.0, value=default_rep_penalty, step=0.01,
                    label="Repetition Penalty"
                )
            
            gr.Markdown("### Subtalker Parameters (Tokenizer V2)")
            gr.Markdown("*These control the subtalker model for finer acoustic details*")
            
            with gr.Row():
                subtalker_dosample = gr.Checkbox(
                    value=True,
                    label="Enable Subtalker Sampling"
                )
                subtalker_temperature = gr.Slider(
                    0.1, 2.0, value=default_subtalker_temp, step=0.05,
                    label="Subtalker Temperature"
                )
            
            with gr.Row():
                subtalker_top_k = gr.Slider(
                    1, 200, value=default_subtalker_top_k, step=1,
                    label="Subtalker Top-k"
                )
                subtalker_top_p = gr.Slider(
                    0.0, 1.0, value=default_subtalker_top_p, step=0.05,
                    label="Subtalker Top-p"
                )

        # Collect all advanced params for passing to functions
        advanced_params = [
            max_new_tokens, temperature, top_k, top_p, repetition_penalty,
            do_sample, subtalker_dosample, subtalker_temperature, 
            subtalker_top_k, subtalker_top_p
        ]

        custom_voice_panel = gr.Group(visible=model_kind == "custom_voice")
        with custom_voice_panel:
            with gr.Row():
                with gr.Column(scale=2):
                    gr.Markdown("### 🎯 Input")
                    text_in_custom = gr.Textbox(
                        label="Text",
                        lines=4,
                        placeholder="Enter text to synthesize.",
                    )
                    with gr.Row():
                        lang_in_custom = gr.Dropdown(
                            label="Language",
                            choices=lang_choices_ui,
                            value=default_lang_value,
                            interactive=True,
                        )
                        spk_in_custom = gr.Dropdown(
                            label="Speaker",
                            choices=spk_choices_disp,
                            value=default_spk_value,
                            interactive=True,
                        )
                    instruct_in = gr.Textbox(
                        label="Instruction (Optional)",
                        lines=2,
                        placeholder="e.g. Say it in a very angry tone",
                    )
                    custom_btn = gr.Button("🎵 Generate", variant="primary", size="lg")

                with gr.Column(scale=3):
                    gr.Markdown("### 🔊 Output")
                    audio_out_custom = gr.Audio(label="Generated Audio", type="numpy")
                    err_custom = gr.Textbox(label="Status", lines=2)

            def run_instruct(text: str, lang_disp: str, spk_disp: str, instruct: str, *adv_params):
                try:
                    if not text or not text.strip():
                        return None, "❌ Text is required."
                    if not spk_disp:
                        return None, "❌ Speaker is required."
                    with _use_model() as state:
                        if state["tts"] is None:
                            return None, "❌ Model not loaded."
                        if state["model_kind"] != "custom_voice":
                            return None, "❌ Current model does not support CustomVoice."
                        language = state["lang_map"].get(lang_disp, "Auto")
                        speaker = state["spk_map"].get(spk_disp, spk_disp)
                        kwargs = _gen_common_kwargs(*adv_params)
                        wavs, sr = state["tts"].generate_custom_voice(
                            text=text.strip(),
                            language=language,
                            speaker=speaker,
                            instruct=(instruct or "").strip() or None,
                            **kwargs,
                        )
                        return _wav_to_gradio_audio(wavs[0], sr), "✅ Generation complete!"
                except Exception as e:
                    return None, f"❌ {type(e).__name__}: {e}"

            custom_btn.click(
                run_instruct,
                inputs=[text_in_custom, lang_in_custom, spk_in_custom, instruct_in] + advanced_params,
                outputs=[audio_out_custom, err_custom],
            )

        voice_design_panel = gr.Group(visible=model_kind == "voice_design")
        with voice_design_panel:
            with gr.Row():
                with gr.Column(scale=2):
                    gr.Markdown("### 🎯 Input")
                    text_in_design = gr.Textbox(
                        label="Text",
                        lines=4,
                        value="It's in the top drawer... wait, it's empty? No way, that's impossible! I'm sure I put it there!",
                    )
                    lang_in_design = gr.Dropdown(
                        label="Language",
                        choices=lang_choices_ui,
                        value=default_lang_value,
                        interactive=True,
                    )
                    design_in = gr.Textbox(
                        label="Voice Design Instruction",
                        lines=3,
                        value="Speak in an incredulous tone, but with a hint of panic beginning to creep into your voice.",
                        info="Describe the desired voice characteristics in detail",
                    )
                    design_btn = gr.Button("🎵 Generate", variant="primary", size="lg")

                with gr.Column(scale=3):
                    gr.Markdown("### 🔊 Output")
                    audio_out_design = gr.Audio(label="Generated Audio", type="numpy")
                    err_design = gr.Textbox(label="Status", lines=2)

            def run_voice_design(text: str, lang_disp: str, design: str, *adv_params):
                try:
                    if not text or not text.strip():
                        return None, "❌ Text is required."
                    if not design or not design.strip():
                        return None, "❌ Voice design instruction is required."
                    with _use_model() as state:
                        if state["tts"] is None:
                            return None, "❌ Model not loaded."
                        if state["model_kind"] != "voice_design":
                            return None, "❌ Current model does not support VoiceDesign."
                        language = state["lang_map"].get(lang_disp, "Auto")
                        kwargs = _gen_common_kwargs(*adv_params)
                        wavs, sr = state["tts"].generate_voice_design(
                            text=text.strip(),
                            language=language,
                            instruct=design.strip(),
                            **kwargs,
                        )
                        return _wav_to_gradio_audio(wavs[0], sr), "✅ Generation complete!"
                except Exception as e:
                    return None, f"❌ {type(e).__name__}: {e}"

            design_btn.click(
                run_voice_design,
                inputs=[text_in_design, lang_in_design, design_in] + advanced_params,
                outputs=[audio_out_design, err_design],
            )

        voice_clone_panel = gr.Group(visible=model_kind == "base")
        with voice_clone_panel:
            with gr.Tabs():
                with gr.Tab("🎤 Clone & Generate"):
                    with gr.Row():
                        with gr.Column(scale=2):
                            gr.Markdown("### 📝 Reference Voice")
                            ref_audio = gr.Audio(
                                label="Reference Audio"
                            )
                            ref_text = gr.Textbox(
                                label="Reference Text",
                                lines=2,
                                placeholder="Transcript of the reference audio (required unless using x-vector only mode)",
                            )
                            xvec_only = gr.Checkbox(
                                label="Use x-vector only mode",
                                value=False
                            )

                        with gr.Column(scale=2):
                            gr.Markdown("### 🎯 Target Speech")
                            text_in_clone = gr.Textbox(
                                label="Target Text",
                                lines=4,
                                placeholder="Enter text to synthesize in the cloned voice",
                            )
                            lang_in_clone = gr.Dropdown(
                                label="Language",
                                choices=lang_choices_ui,
                                value=default_lang_value,
                                interactive=True,
                            )
                            clone_btn = gr.Button("🎵 Generate", variant="primary", size="lg")

                        with gr.Column(scale=3):
                            gr.Markdown("### 🔊 Output")
                            audio_out_clone = gr.Audio(label="Generated Audio", type="numpy")
                            err_clone = gr.Textbox(label="Status", lines=2)

                    def run_voice_clone(ref_aud, ref_txt: str, use_xvec: bool, text: str, lang_disp: str, *adv_params):
                        try:
                            if not text or not text.strip():
                                return None, "❌ Target text is required."
                            at = _audio_to_tuple(ref_aud)
                            if at is None:
                                return None, "❌ Reference audio is required."
                            if (not use_xvec) and (not ref_txt or not ref_txt.strip()):
                                return None, (
                                    "❌ Reference text is required when x-vector only mode is NOT enabled.\n"
                                    "Either provide reference text or enable x-vector only mode (though quality will be lower)."
                                )
                            with _use_model() as state:
                                if state["tts"] is None:
                                    return None, "❌ Model not loaded."
                                if state["model_kind"] != "base":
                                    return None, "❌ Current model does not support voice cloning."
                                language = state["lang_map"].get(lang_disp, "Auto")
                                kwargs = _gen_common_kwargs(*adv_params)
                                wavs, sr = state["tts"].generate_voice_clone(
                                    text=text.strip(),
                                    language=language,
                                    ref_audio=at,
                                    ref_text=(ref_txt.strip() if ref_txt else None),
                                    x_vector_only_mode=bool(use_xvec),
                                    **kwargs,
                                )
                                return _wav_to_gradio_audio(wavs[0], sr), "✅ Generation complete!"
                        except Exception as e:
                            return None, f"❌ {type(e).__name__}: {e}"

                    clone_btn.click(
                        run_voice_clone,
                        inputs=[ref_audio, ref_text, xvec_only, text_in_clone, lang_in_clone] + advanced_params,
                        outputs=[audio_out_clone, err_clone],
                    )

                with gr.Tab("💾 Save / Load Voice"):
                    with gr.Row():
                        with gr.Column(scale=2):
                            gr.Markdown(
                                """
### 💾 Save Voice Profile
Create a reusable voice profile from reference audio that can be loaded later.
"""
                            )
                            ref_audio_s = gr.Audio(label="Reference Audio", type="numpy")
                            ref_text_s = gr.Textbox(
                                label="Reference Text",
                                lines=2,
                                placeholder="Required if not using x-vector only mode.",
                            )
                            xvec_only_s = gr.Checkbox(
                                label="Use x-vector only mode",
                                value=False
                            )
                            save_btn = gr.Button("💾 Save Voice Profile", variant="primary")
                            prompt_file_out = gr.File(label="Voice Profile File (.pt)")

                        with gr.Column(scale=2):
                            gr.Markdown(
                                """
### 📂 Load Voice & Generate
Upload a previously saved voice profile and generate new speech.
"""
                            )
                            prompt_file_in = gr.File(label="Upload Voice Profile (.pt)")
                            text_in_clone2 = gr.Textbox(
                                label="Target Text",
                                lines=4,
                                placeholder="Enter text to synthesize with loaded voice",
                            )
                            lang_in_clone2 = gr.Dropdown(
                                label="Language",
                                choices=lang_choices_ui,
                                value=default_lang_value,
                                interactive=True,
                            )
                            gen_btn2 = gr.Button("🎵 Generate", variant="primary")

                        with gr.Column(scale=3):
                            gr.Markdown("### 🔊 Output")
                            audio_out_clone2 = gr.Audio(label="Generated Audio", type="numpy")
                            err_clone2 = gr.Textbox(label="Status", lines=2)

                    def save_prompt(ref_aud, ref_txt: str, use_xvec: bool):
                        try:
                            at = _audio_to_tuple(ref_aud)
                            if at is None:
                                return None, "❌ Reference audio is required."
                            if (not use_xvec) and (not ref_txt or not ref_txt.strip()):
                                return None, (
                                    "❌ Reference text is required when x-vector only mode is NOT enabled.\n"
                                    "Either provide reference text or enable x-vector only mode (though quality will be lower)."
                                )
                            with _use_model() as state:
                                if state["tts"] is None:
                                    return None, "❌ Model not loaded."
                                if state["model_kind"] != "base":
                                    return None, "❌ Current model does not support voice cloning."
                                items = state["tts"].create_voice_clone_prompt(
                                    ref_audio=at,
                                    ref_text=(ref_txt.strip() if ref_txt else None),
                                    x_vector_only_mode=bool(use_xvec),
                                )
                            payload = {
                                "items": [asdict(it) for it in items],
                            }
                            fd, out_path = tempfile.mkstemp(prefix="voice_clone_prompt_", suffix=".pt")
                            os.close(fd)
                            torch.save(payload, out_path)
                            return out_path, "✅ Voice profile saved successfully!"
                        except Exception as e:
                            return None, f"❌ {type(e).__name__}: {e}"

                    def load_prompt_and_gen(file_obj, text: str, lang_disp: str, *adv_params):
                        try:
                            if file_obj is None:
                                return None, "❌ Voice profile file is required."
                            if not text or not text.strip():
                                return None, "❌ Target text is required."

                            path = getattr(file_obj, "name", None) or getattr(file_obj, "path", None) or str(file_obj)
                            payload = torch.load(path, map_location="cpu", weights_only=True)
                            if not isinstance(payload, dict) or "items" not in payload:
                                return None, "❌ Invalid file format."

                            items_raw = payload["items"]
                            if not isinstance(items_raw, list) or len(items_raw) == 0:
                                return None, "❌ Empty voice items in profile."

                            items: List[VoiceClonePromptItem] = []
                            for d in items_raw:
                                if not isinstance(d, dict):
                                    return None, "❌ Invalid item format in file."
                                ref_code = d.get("ref_code", None)
                                if ref_code is not None and not torch.is_tensor(ref_code):
                                    ref_code = torch.tensor(ref_code)
                                ref_spk = d.get("ref_spk_embedding", None)
                                if ref_spk is None:
                                    return None, "❌ Missing speaker embedding."
                                if not torch.is_tensor(ref_spk):
                                    ref_spk = torch.tensor(ref_spk)

                                items.append(
                                    VoiceClonePromptItem(
                                        ref_code=ref_code,
                                        ref_spk_embedding=ref_spk,
                                        x_vector_only_mode=bool(d.get("x_vector_only_mode", False)),
                                        icl_mode=bool(d.get("icl_mode", not bool(d.get("x_vector_only_mode", False)))),
                                        ref_text=d.get("ref_text", None),
                                    )
                                )

                            with _use_model() as state:
                                if state["tts"] is None:
                                    return None, "❌ Model not loaded."
                                if state["model_kind"] != "base":
                                    return None, "❌ Current model does not support voice cloning."
                                language = state["lang_map"].get(lang_disp, "Auto")
                                kwargs = _gen_common_kwargs(*adv_params)
                                wavs, sr = state["tts"].generate_voice_clone(
                                    text=text.strip(),
                                    language=language,
                                    voice_clone_prompt=items,
                                    **kwargs,
                                )
                                return _wav_to_gradio_audio(wavs[0], sr), "✅ Generation complete!"
                        except Exception as e:
                            return None, (
                                f"❌ Failed to read or use voice profile. Check file format/content.\n"
                                f"{type(e).__name__}: {e}"
                            )

                    save_btn.click(
                        save_prompt,
                        inputs=[ref_audio_s, ref_text_s, xvec_only_s],
                        outputs=[prompt_file_out, err_clone2],
                    )
                    gen_btn2.click(
                        load_prompt_and_gen,
                        inputs=[prompt_file_in, text_in_clone2, lang_in_clone2] + advanced_params,
                        outputs=[audio_out_clone2, err_clone2],
                    )

        # Parameter documentation
        with gr.Accordion("📖 Parameter Guide", open=False):
            gr.Markdown("""
### Main Sampling Parameters

**Max New Tokens** (512-8192)
- Maximum number of audio tokens to generate
- Higher values allow for longer audio output
- Recommended: 2048 for most use cases

**Temperature** (0.1-2.0)
- Controls randomness in token selection
- Lower (0.5-0.8): More consistent, predictable output
- Higher (1.0-1.5): More varied, creative output
- Recommended: 0.9 for natural speech

**Top-k** (1-200)
- Limits selection to top k most probable tokens
- Lower values: More focused, less diverse
- Higher values: More diverse, potentially less coherent
- Recommended: 50

**Top-p / Nucleus Sampling** (0.0-1.0)
- Cumulative probability threshold for token selection
- 0.9: Consider tokens that make up 90% of probability mass
- Works together with top-k
- Recommended: 1.0 (disabled) or 0.9-0.95

**Repetition Penalty** (1.0-2.0)
- Penalizes tokens that have already appeared
- 1.0: No penalty
- 1.05-1.1: Subtle reduction in repetition
- Higher: Stronger penalty, may affect naturalness
- Recommended: 1.05

**Enable Sampling**
- When enabled: Uses temperature, top-k, top-p for varied output
- When disabled: Uses greedy decoding (always picks most probable token)
- Recommended: Enabled for natural speech

### Subtalker Parameters (Tokenizer V2)

The subtalker model generates fine-grained acoustic details. These parameters control its behavior:

**Subtalker Temperature** (0.1-2.0)
- Similar to main temperature but for acoustic details
- Recommended: 0.9

**Subtalker Top-k** (1-200)
- Limits acoustic token selection
- Recommended: 50

**Subtalker Top-p** (0.0-1.0)
- Nucleus sampling for acoustic details
- Recommended: 1.0

**Enable Subtalker Sampling**
- Controls whether subtalker uses sampling or greedy decoding
- Recommended: Enabled

### Tips for Best Results

1. **For consistent, professional voice**: Lower temperature (0.6-0.8), lower top-k (30-40)
2. **For natural, varied speech**: Default settings (temp 0.9, top-k 50)
3. **For creative, expressive speech**: Higher temperature (1.0-1.2), higher top-p (0.95)
4. **If speech sounds repetitive**: Increase repetition penalty to 1.1-1.15
5. **If speech sounds unnatural**: Lower repetition penalty to 1.0-1.05
6. **For longer audio**: Increase max_new_tokens to 4096 or higher

### Model-Specific Notes

**Base Model (Voice Clone)**
- Requires reference audio for voice cloning
- X-vector mode: Lower quality but no transcript needed
- ICL mode: Higher quality but requires reference transcript
- Best results: 5-30 seconds of clean reference audio

**CustomVoice Model**
- Pre-trained voices with instruction control
- Use instruction field for emotion/style control
- Examples: "very happy", "angry tone", "whisper"

**VoiceDesign Model**
- Create custom voices from text descriptions
- Be specific in voice design instructions
- Describe: tone, pitch, age, emotion, speaking style
- Example: "Middle-aged male voice, deep and authoritative, speaking slowly and clearly"
""")

        model_info_md = gr.Markdown(
            _format_model_info(state["lang_choices_disp"], state["spk_choices_disp"])
        )

        def load_model(ckpt_value: str):
            try:
                new_state = _reload_model(ckpt_value, device, dtype, attn_impl)
                lang_choices_ui = new_state["lang_choices_ui"]
                lang_value = _default_lang_value(lang_choices_ui)
                spk_choices = new_state["spk_choices_disp"]
                spk_value = _default_spk_value(spk_choices)
                return (
                    _format_header(new_state["ckpt"], new_state["model_kind"]),
                    _format_model_info(new_state["lang_choices_disp"], new_state["spk_choices_disp"]),
                    gr.update(visible=new_state["model_kind"] == "custom_voice"),
                    gr.update(visible=new_state["model_kind"] == "voice_design"),
                    gr.update(visible=new_state["model_kind"] == "base"),
                    gr.update(choices=lang_choices_ui, value=lang_value),
                    gr.update(choices=lang_choices_ui, value=lang_value),
                    gr.update(choices=lang_choices_ui, value=lang_value),
                    gr.update(choices=lang_choices_ui, value=lang_value),
                    gr.update(choices=spk_choices, value=spk_value),
                    gr.update(value=new_state["ckpt"]),
                    "✅ Model loaded successfully!",
                )
            except Exception as e:
                return (
                    gr.update(),
                    gr.update(),
                    gr.update(),
                    gr.update(),
                    gr.update(),
                    gr.update(),
                    gr.update(),
                    gr.update(),
                    gr.update(),
                    gr.update(),
                    gr.update(),
                    f"❌ {type(e).__name__}: {e}",
                )

        load_btn.click(
            load_model,
            inputs=[ckpt_in],
            outputs=[
                header_md,
                model_info_md,
                custom_voice_panel,
                voice_design_panel,
                voice_clone_panel,
                lang_in_custom,
                lang_in_design,
                lang_in_clone,
                lang_in_clone2,
                spk_in_custom,
                ckpt_in,
                load_status,
            ],
        )

    return demo


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.checkpoint and not args.checkpoint_pos:
        parser.print_help()
        return 0

    ckpt = _resolve_checkpoint(args)

    dtype = _dtype_from_str(args.dtype)
    attn_impl = "flash_attention_2" if args.flash_attn else None

    print(f"Loading model from: {ckpt}")
    print(f"Device: {args.device}")
    print(f"Dtype: {dtype}")
    print(f"Attention: {attn_impl}")

    tts = Qwen3TTSModel.from_pretrained(
        ckpt,
        device_map=args.device,
        dtype=dtype,
        attn_implementation=attn_impl,
    )

    print("Model loaded successfully!")

    gen_kwargs_default = _collect_gen_kwargs(args)
    state = _build_model_state(tts, ckpt)
    _set_model_state(state)
    demo = build_demo(state, gen_kwargs_default, args.device, dtype, attn_impl)

    launch_kwargs: Dict[str, Any] = dict(
        server_name=args.ip,
        server_port=args.port,
        share=args.share,
        ssl_verify=True if args.ssl_verify else False,
    )
    if args.ssl_certfile is not None:
        launch_kwargs["ssl_certfile"] = args.ssl_certfile
    if args.ssl_keyfile is not None:
        launch_kwargs["ssl_keyfile"] = args.ssl_keyfile

    print(f"\n🚀 Launching Gradio interface at http://{args.ip}:{args.port}")
    demo.queue(default_concurrency_limit=int(args.concurrency)).launch(**launch_kwargs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())