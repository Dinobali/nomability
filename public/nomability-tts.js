(() => {
  const panel = document.querySelector('[data-tts-panel]');
  if (!panel) return;

  const TTS_BASE_URL = 'https://ai.nomability.net';

  const statusChip = panel.querySelector('[data-tts-status]');
  const textField = panel.querySelector('[data-tts-text]');
  const modeSelect = panel.querySelector('[data-tts-mode]');
  const languageSelect = panel.querySelector('[data-tts-language]');
  const voiceDesignField = panel.querySelector('[data-tts-instruct]');
  const speakerSelect = panel.querySelector('[data-tts-speaker]');
  const styleField = panel.querySelector('[data-tts-style]');
  const modelStatus = panel.querySelector('[data-tts-model]');
  const refAudioInput = panel.querySelector('[data-tts-ref-audio]');
  const refTextInput = panel.querySelector('[data-tts-ref-text]');
  const xVectorToggle = panel.querySelector('[data-tts-x-vector]');
  const generateBtn = panel.querySelector('[data-tts-generate]');
  const clearBtn = panel.querySelector('[data-tts-clear]');
  const downloadBtn = panel.querySelector('[data-tts-download]');
  const audioEl = panel.querySelector('[data-tts-audio]');
  const voiceDesignGroup = panel.querySelector('[data-tts-group="voice-design"]');
  const customGroup = panel.querySelector('[data-tts-group="custom"]');
  const voiceCloneGroup = panel.querySelector('[data-tts-group="voice-clone"]');

  if (!textField || !generateBtn || !audioEl) return;

  let audioUrl = '';
  let audioBlob = null;
  let isGenerating = false;
  let modelLoading = false;
  let currentModelKind = null;

  const defaultVoiceDescription =
    'Professional female voice, clear and articulate.';

  const setStatus = (text) => {
    if (statusChip) statusChip.textContent = text;
  };

  const setModelStatus = (text) => {
    if (modelStatus) modelStatus.textContent = text;
  };

  const resetAudio = () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = '';
    }
    audioBlob = null;
    audioEl.removeAttribute('src');
    audioEl.hidden = true;
    if (downloadBtn) downloadBtn.disabled = true;
  };

  const setGeneratingState = (state) => {
    isGenerating = state;
    generateBtn.disabled = state;
    if (clearBtn) clearBtn.disabled = state;
  };

  const toggleModeFields = () => {
    const mode = modeSelect?.value || 'voice_design';
    const isCustom = mode === 'custom_voice';
    const isClone = mode === 'voice_clone';
    if (voiceDesignGroup) voiceDesignGroup.hidden = isCustom || isClone;
    if (customGroup) customGroup.hidden = !isCustom;
    if (voiceCloneGroup) voiceCloneGroup.hidden = !isClone;
  };

  const resolveModelForMode = (mode) => {
    if (mode === 'custom_voice') return 'custom_voice';
    if (mode === 'voice_clone') return 'base';
    return 'voice_design';
  };

  const labelForModel = (model) => {
    if (model === 'custom_voice') return 'Custom voice';
    if (model === 'voice_clone' || model === 'base') return 'Base';
    if (model === 'voice_design') return 'Voice design';
    return model || 'Unknown';
  };

  const loadModel = async (model) => {
    if (modelLoading || isGenerating) return false;
    modelLoading = true;
    generateBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    setStatus(`Loading ${labelForModel(model)} model...`);
    try {
      const response = await fetch(`${TTS_BASE_URL}/tts/load-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(errorText || `Model load failed (${response.status})`);
      }
      const data = await response.json().catch(() => ({}));
      currentModelKind = data.model_type || model;
      setModelStatus(`Loaded model: ${labelForModel(currentModelKind)}`);
      setStatus('Model ready');
      return true;
    } catch (error) {
      setStatus(`Model load failed: ${error.message || error}`);
      return false;
    } finally {
      modelLoading = false;
      generateBtn.disabled = false;
      if (clearBtn) clearBtn.disabled = false;
    }
  };

  const ensureModelForMode = async (mode) => {
    const required = resolveModelForMode(mode);
    if (currentModelKind && currentModelKind === required) return true;
    return loadModel(required);
  };

  const populateSelect = (select, items, fallbackValue) => {
    if (!select || !Array.isArray(items) || items.length === 0) return;
    const current = select.value;
    select.innerHTML = '';
    items.forEach((item) => {
      const option = document.createElement('option');
      option.value = item;
      option.textContent = item;
      select.appendChild(option);
    });
    if (current && items.includes(current)) {
      select.value = current;
    } else if (fallbackValue && items.includes(fallbackValue)) {
      select.value = fallbackValue;
    }
  };

  const loadTtsInfo = async () => {
    try {
      const response = await fetch(`${TTS_BASE_URL}/tts/info`);
      if (!response.ok) return;
      const info = await response.json();
      const languages = Array.isArray(info.supported_languages)
        ? info.supported_languages
        : [];
      const speakers =
        info?.models?.custom_voice?.available_speakers ||
        info?.available_speakers ||
        [];

      populateSelect(languageSelect, languages, 'Auto');
      populateSelect(speakerSelect, speakers, 'Vivian');
      if (info.current_model_type) {
        currentModelKind = info.current_model_type;
        setModelStatus(`Loaded model: ${labelForModel(currentModelKind)}`);
      } else {
        setModelStatus('Loaded model: Unknown');
      }
    } catch (error) {
      // Silent fallback to defaults in the markup.
    }
  };

  const generateAudio = async () => {
    if (isGenerating) return;
    const text = (textField.value || '').trim();
    if (!text) {
      setStatus('Add text to synthesize.');
      return;
    }

    const mode = modeSelect?.value || 'voice_design';
    const language = (languageSelect?.value || 'Auto').trim() || 'Auto';

    const ready = await ensureModelForMode(mode);
    if (!ready) return;

    let endpoint = '/tts/voice-design';
    let payload = { text, language };
    let useFormData = false;

    if (mode === 'custom_voice') {
      endpoint = '/tts/custom-voice';
      payload.speaker = (speakerSelect?.value || 'Vivian').trim() || 'Vivian';
      const style = (styleField?.value || '').trim();
      if (style) payload.instruct = style;
    } else if (mode === 'voice_clone') {
      endpoint = '/tts/voice-clone';
      const refAudio = refAudioInput?.files?.[0];
      if (!refAudio) {
        setStatus('Upload a reference audio file.');
        return;
      }
      useFormData = true;
      const form = new FormData();
      form.append('text', text);
      form.append('language', language);
      form.append('ref_audio', refAudio, refAudio.name || 'reference.wav');
      const refText = (refTextInput?.value || '').trim();
      if (refText) form.append('ref_text', refText);
      form.append('x_vector_only', xVectorToggle?.checked ? 'true' : 'false');
      payload = form;
    } else {
      const description = (voiceDesignField?.value || '').trim();
      payload.instruct = description || defaultVoiceDescription;
    }

    setGeneratingState(true);
    setStatus('Generating audio...');
    resetAudio();

    try {
      const response = await fetch(`${TTS_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: useFormData ? undefined : { 'Content-Type': 'application/json' },
        body: useFormData ? payload : JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(errorText || `Request failed (${response.status})`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('audio')) {
        const errorText = await response.text().catch(() => '');
        throw new Error(errorText || 'Unexpected response from TTS service.');
      }

      const blob = await response.blob();
      if (!blob || !blob.size) {
        throw new Error('No audio returned.');
      }

      audioBlob = blob;
      audioUrl = URL.createObjectURL(blob);
      audioEl.src = audioUrl;
      audioEl.hidden = false;
      if (downloadBtn) downloadBtn.disabled = false;
      setStatus('Ready');
    } catch (error) {
      setStatus(`TTS failed: ${error.message || error}`);
    } finally {
      setGeneratingState(false);
    }
  };

  const downloadAudio = () => {
    if (!audioBlob || !audioUrl) {
      setStatus('No audio available to download.');
      return;
    }
    const link = document.createElement('a');
    link.href = audioUrl;
    link.download = 'nomability-tts.wav';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const clearAll = () => {
    if (isGenerating) return;
    if (textField) textField.value = '';
    if (voiceDesignField) voiceDesignField.value = '';
    if (styleField) styleField.value = '';
    if (refTextInput) refTextInput.value = '';
    if (refAudioInput) refAudioInput.value = '';
    if (xVectorToggle) xVectorToggle.checked = false;
    resetAudio();
    setStatus('Idle');
  };

  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      toggleModeFields();
      ensureModelForMode(modeSelect.value);
    });
  }
  generateBtn.addEventListener('click', generateAudio);
  if (clearBtn) clearBtn.addEventListener('click', clearAll);
  if (downloadBtn) downloadBtn.addEventListener('click', downloadAudio);

  toggleModeFields();
  loadTtsInfo();
  setStatus('Idle');
})();
