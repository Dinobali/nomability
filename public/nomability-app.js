(() => {
  const form = document.getElementById('nm-job-form');
  if (!form) return;

  const fileInput = document.getElementById('nm-files');
  const dropzone = document.querySelector('[data-dropzone]');
  const fileList = document.querySelector('[data-file-list]');
  const progressBar = document.querySelector('[data-progress-bar]');
  const progressLabel = document.querySelector('[data-progress-label]');
  const statusLabel = document.querySelector('[data-status]');
  const apiInput = document.getElementById('api-base');
  const ollamaInput = document.getElementById('ollama-base');

  const outputPanels = {
    transcript: document.querySelector('[data-output="transcript"]'),
    summary: document.querySelector('[data-output="summary"]'),
    translation: document.querySelector('[data-output="translation"]'),
    subtitles: document.querySelector('[data-output="subtitles"]'),
    json: document.querySelector('[data-output="json"]')
  };

  const glossaryToggle = document.getElementById('task-glossary');
  const glossaryField = document.getElementById('glossary');

  let progressTimer;
  let progressValue = 0;
  let currentResult = {};
  let activeFiles = [];
  let lastPayload;
  let pollDelayMs = 2000;
  let pollAttempts = 0;

  const API_STORAGE_KEY = 'nmApiBase';
  const LEGACY_STORAGE_KEY = 'apiEndpoint';
  const OLLAMA_STORAGE_KEY = 'nmOllamaBase';
  const normalizeApiBase = (value) => (value || '').trim().replace(/\/+$/, '');
  const deriveOllamaBase = (base) => {
    const fallback = 'http://localhost:11434';
    if (!base) return fallback;
    try {
      const url = new URL(base);
      url.port = '11434';
      url.pathname = '';
      url.search = '';
      url.hash = '';
      return normalizeApiBase(url.toString());
    } catch (error) {
      return fallback;
    }
  };
  const queryApiBase = normalizeApiBase(new URLSearchParams(window.location.search).get('apiBase'));
  const storedApiBase = normalizeApiBase(
    localStorage.getItem(API_STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY)
  );
  const defaultApiBase = normalizeApiBase(
    apiInput?.dataset.defaultApiBase || apiInput?.value
  );
  let apiBase = queryApiBase || storedApiBase || defaultApiBase || window.location.origin;
  const queryOllamaBase = normalizeApiBase(new URLSearchParams(window.location.search).get('ollamaBase'));
  const storedOllamaBase = normalizeApiBase(localStorage.getItem(OLLAMA_STORAGE_KEY));
  const defaultOllamaBase = normalizeApiBase(
    ollamaInput?.dataset.defaultOllamaBase || ollamaInput?.value
  );
  let ollamaBase = queryOllamaBase || storedOllamaBase || defaultOllamaBase || deriveOllamaBase(apiBase);

  const syncApiInput = () => {
    if (!apiInput) return;
    apiInput.value = queryApiBase || storedApiBase || defaultApiBase || '';
    apiInput.placeholder = window.location.origin;
  };

  const syncOllamaInput = () => {
    if (!ollamaInput) return;
    const fallback = deriveOllamaBase(apiBase);
    ollamaInput.value = queryOllamaBase || storedOllamaBase || defaultOllamaBase || fallback;
    ollamaInput.placeholder = fallback;
  };

  const updateApiBase = (value) => {
    const normalized = normalizeApiBase(value);
    if (normalized) {
      localStorage.setItem(API_STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(API_STORAGE_KEY);
    }
    apiBase = normalized || window.location.origin;
    if (ollamaInput && !queryOllamaBase && !localStorage.getItem(OLLAMA_STORAGE_KEY)) {
      const fallback = deriveOllamaBase(apiBase);
      if (!ollamaInput.value) {
        ollamaInput.value = fallback;
      }
      ollamaInput.placeholder = fallback;
      ollamaBase = normalizeApiBase(ollamaInput.value) || fallback;
    }
  };

  const updateOllamaBase = (value) => {
    const normalized = normalizeApiBase(value);
    if (normalized) {
      localStorage.setItem(OLLAMA_STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(OLLAMA_STORAGE_KEY);
    }
    ollamaBase = normalized || deriveOllamaBase(apiBase);
  };

  const updateProgress = (value) => {
    progressValue = value;
    if (progressBar) progressBar.style.width = `${value}%`;
    if (progressLabel) progressLabel.textContent = `${value}%`;
  };

  const startProgress = () => {
    updateProgress(10);
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      if (progressValue >= 90) return;
      updateProgress(Math.min(90, progressValue + Math.floor(Math.random() * 8 + 4)));
    }, 700);
  };

  const startTranslationProgress = () => {
    updateProgress(10);
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      if (progressValue >= 90) return;
      updateProgress(Math.min(90, progressValue + Math.floor(Math.random() * 6 + 2)));
    }, 650);
  };

  const stopProgress = () => {
    clearInterval(progressTimer);
    updateProgress(100);
  };

  const setStatus = (text) => {
    if (statusLabel) statusLabel.textContent = text;
  };

  const updateFileList = (files) => {
    if (!fileList) return;
    if (!files || files.length === 0) {
      fileList.innerHTML = '<span>No files selected.</span>';
      return;
    }
    fileList.innerHTML = '';
    Array.from(files).forEach((file) => {
      const item = document.createElement('div');
      item.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
      fileList.appendChild(item);
    });
  };

  const renderResult = (result) => {
    const normalized = typeof result === 'string' ? { transcript: result } : result || {};
    currentResult = normalized;
    if (outputPanels.transcript) {
      outputPanels.transcript.textContent = normalized.transcript || normalized.text || 'No transcript returned.';
    }
    if (outputPanels.summary) {
      outputPanels.summary.textContent = normalized.summary || 'No summary returned.';
    }
    if (outputPanels.translation) {
      const translationText =
        normalized.translation?.text ||
        normalized.translation ||
        normalized.translated_text ||
        normalized.translatedText;
      outputPanels.translation.textContent = translationText || 'No translation returned.';
    }
    if (outputPanels.subtitles) {
      const subtitlesText =
        normalized.subtitles?.srt ||
        normalized.subtitles?.vtt ||
        normalized.subtitles ||
        'No subtitles returned.';
      outputPanels.subtitles.textContent = subtitlesText;
    }
    if (outputPanels.json) {
      outputPanels.json.textContent = JSON.stringify(normalized, null, 2);
    }
  };

  const getAuthHeaders = () => {
    const token = localStorage.getItem('nmAuthToken');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const resetPolling = () => {
    pollDelayMs = 2000;
    pollAttempts = 0;
  };

  const pollJob = async (jobId) => {
    try {
      const response = await fetch(`${apiBase}/api/ai/jobs/${jobId}`, {
        headers: {
          ...getAuthHeaders()
        }
      });
      if (response.status === 401) {
        stopProgress();
        setStatus('Please log in to view job status.');
        return;
      }
      if (!response.ok) throw new Error('Job status failed');
      const data = await response.json();

      if (data.progress !== undefined) updateProgress(Number(data.progress));
      if (data.status) setStatus(data.status);

      if (data.status === 'completed') {
        stopProgress();
        renderResult(data.result || data);
        setStatus('Completed');
        await ensureTranslation(lastPayload);
        return;
      }
      if (data.status === 'failed') {
        stopProgress();
        setStatus('Failed');
        return;
      }
      pollAttempts += 1;
      if (pollAttempts > 3) {
        pollDelayMs = Math.min(pollDelayMs + 1000, 10000);
      }
      const jitter = Math.floor(Math.random() * 300);
      setTimeout(() => pollJob(jobId), pollDelayMs + jitter);
    } catch (error) {
      stopProgress();
      setStatus('Failed to fetch job status');
    }
  };

  const collectFormData = () => {
    const formData = new FormData();
    const files = activeFiles || [];
    files.forEach((file) => formData.append('files', file));

    const payload = {
      model: form.querySelector('#model')?.value || 'base',
      language: form.querySelector('#language')?.value || '',
      targetLanguage: form.querySelector('#target-language')?.value || '',
      summaryStyle: form.querySelector('#summary-style')?.value || 'bullet',
      speakerCount: form.querySelector('#speaker-count')?.value || 'auto',
      outputFormat: form.querySelector('#output-format')?.value || 'txt',
      timestamps: form.querySelector('#timestamps')?.checked || false,
      tasks: {
        transcribe: form.querySelector('#task-transcribe')?.checked || false,
        translate: form.querySelector('#task-translate')?.checked || false,
        summarize: form.querySelector('#task-summarize')?.checked || false,
        diarize: form.querySelector('#task-diarize')?.checked || false,
        subtitles: form.querySelector('#task-subtitle')?.checked || false,
        sync: form.querySelector('#task-sync')?.checked || false,
        glossary: form.querySelector('#task-glossary')?.checked || false
      },
      glossary: form.querySelector('#glossary')?.value || ''
    };

    Object.entries(payload).forEach(([key, value]) => {
      if (typeof value === 'object') {
        formData.append(key, JSON.stringify(value));
      } else {
        formData.append(key, value);
      }
    });

    return { formData, hasFiles: files.length > 0, payload };
  };

  const buildTranslationPrompt = (text, targetLanguage, sourceLanguage) => {
    const sourceLine = sourceLanguage ? ` from ${sourceLanguage}` : '';
    return `Translate the following text${sourceLine} to ${targetLanguage}. Return only the translated text.\n\n${text}`;
  };

  const translateWithOllama = async (text, targetLanguage, sourceLanguage) => {
    if (!ollamaBase) {
      throw new Error('Ollama base URL is not set');
    }
    const response = await fetch(`${ollamaBase}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'translategemma:12b',
        prompt: buildTranslationPrompt(text, targetLanguage, sourceLanguage),
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed (${response.status})`);
    }

    const data = await response.json();
    return (data.response || '').trim();
  };

  const ensureTranslation = async (payload) => {
    if (!payload?.tasks?.translate) return;
    const targetLanguage = (payload.targetLanguage || '').trim();
    if (!targetLanguage) {
      if (outputPanels.translation) {
        outputPanels.translation.textContent = 'Set a target language to translate.';
      }
      setStatus('Translation skipped: set a target language.');
      return;
    }
    const existingTranslation =
      currentResult.translation ||
      currentResult.translated_text ||
      currentResult.translatedText ||
      currentResult.translation?.text;
    if (existingTranslation) return;

    const transcript = currentResult.transcript || currentResult.text;
    if (!transcript) return;

    if (outputPanels.translation) {
      outputPanels.translation.textContent = 'Translating with Ollama...';
    }
    startTranslationProgress();
    setStatus('Translating');
    try {
      const translation = await translateWithOllama(
        transcript,
        targetLanguage,
        (payload.language || '').trim()
      );
      currentResult = { ...currentResult, translation };
      renderResult(currentResult);
      setStatus('Completed');
      stopProgress();
    } catch (error) {
      if (outputPanels.translation) {
        outputPanels.translation.textContent = 'Translation failed. Check Ollama.';
      }
      setStatus('Translation failed. Check Ollama.');
      stopProgress();
    }
  };

  const buildLegacyFormData = (payload) => {
    const legacyFormData = new FormData();
    const files = activeFiles || [];
    files.forEach((file) => legacyFormData.append('file', file));
    legacyFormData.append('model', payload.model || 'base');
    if (payload.language) legacyFormData.append('language', payload.language);

    const outputFormat = payload.outputFormat || 'txt';
    const responseFormat =
      outputFormat === 'json'
        ? 'verbose_json'
        : outputFormat === 'srt'
          ? 'srt'
          : outputFormat === 'vtt'
            ? 'vtt'
            : 'text';
    legacyFormData.append('response_format', responseFormat);

    if (payload.timestamps) {
      legacyFormData.append('timestamp_granularities', 'segment');
    }

    return legacyFormData;
  };

  const submitLegacyTranscription = async (payload) => {
    const legacyBase = apiBase.endsWith('/v1') ? apiBase.slice(0, -3) : apiBase;
    const response = await fetch(`${legacyBase}/v1/transcriptions`, {
      method: 'POST',
      body: buildLegacyFormData(payload)
    });

    if (!response.ok) {
      throw new Error(`Legacy request failed (${response.status})`);
    }

    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    stopProgress();
    setStatus('Completed');
    renderResult(data);
    await ensureTranslation(payload);
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const { formData, hasFiles, payload } = collectFormData();
    lastPayload = payload;

    if (!hasFiles) {
      setStatus('Add at least one audio or video file.');
      return;
    }

    setStatus('Uploading');
    startProgress();

    try {
      const response = await fetch(`${apiBase}/api/ai/jobs`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders()
        },
        body: formData
      });
      if (response.status === 401) {
        stopProgress();
        setStatus('Please log in to start a job.');
        return;
      }
      if (response.status === 402) {
        stopProgress();
        const data = await response.json().catch(() => ({}));
        setStatus(data.error || 'Plan limit reached.');
        return;
      }

      if (response.status === 404 || response.status === 405) {
        setStatus('Using legacy transcription endpoint');
        await submitLegacyTranscription(payload);
        return;
      }

      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }

      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json')
        ? await response.json()
        : { transcript: await response.text() };

      if (data.jobId) {
        resetPolling();
        setStatus('Processing');
        pollJob(data.jobId);
      } else {
        stopProgress();
        setStatus('Completed');
        renderResult(data.result || data);
        await ensureTranslation(payload);
      }
    } catch (error) {
      stopProgress();
      setStatus('Request failed. Check the API base URL.');
    }
  });

  const tabs = document.querySelectorAll('[data-tab-target]');
  const panels = document.querySelectorAll('[data-tab-panel]');
  const downloadButtons = document.querySelectorAll('[data-download]');

  const activateTab = (name) => {
    tabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.tabTarget === name);
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== name;
    });
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tabTarget));
  });

  if (tabs.length) activateTab(tabs[0].dataset.tabTarget);

  const getDownloadPayload = (type) => {
    if (type === 'json') {
      return {
        content: JSON.stringify(currentResult || {}, null, 2),
        filename: 'nomability-result.json',
        mime: 'application/json'
      };
    }
    if (type === 'subtitles') {
      return {
        content: currentResult.subtitles?.srt || currentResult.subtitles || '',
        filename: 'nomability-subtitles.srt',
        mime: 'text/plain'
      };
    }
    return {
      content: currentResult.transcript || currentResult.text || '',
      filename: 'nomability-transcript.txt',
      mime: 'text/plain'
    };
  };

  const downloadText = (type) => {
    const payload = getDownloadPayload(type);
    if (!payload.content) {
      setStatus('No output available for download.');
      return;
    }
    const blob = new Blob([payload.content], { type: payload.mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = payload.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  downloadButtons.forEach((button) => {
    button.addEventListener('click', () => downloadText(button.dataset.download));
  });

  const syncGlossaryState = () => {
    if (!glossaryToggle || !glossaryField) return;
    glossaryField.disabled = !glossaryToggle.checked;
    glossaryField.placeholder = glossaryToggle.checked
      ? 'Add preferred terms, one per line.'
      : 'Enable glossary to lock terminology.';
  };

  if (glossaryToggle) {
    glossaryToggle.addEventListener('change', syncGlossaryState);
    syncGlossaryState();
  }

  if (apiInput) {
    syncApiInput();
    apiInput.addEventListener('change', () => updateApiBase(apiInput.value));
    apiInput.addEventListener('blur', () => updateApiBase(apiInput.value));
  }

  if (ollamaInput) {
    syncOllamaInput();
    ollamaInput.addEventListener('change', () => updateOllamaBase(ollamaInput.value));
    ollamaInput.addEventListener('blur', () => updateOllamaBase(ollamaInput.value));
  }

  const setActiveFiles = (files) => {
    activeFiles = Array.from(files || []);
    updateFileList(activeFiles);
  };

  if (fileInput) {
    fileInput.addEventListener('change', () => setActiveFiles(fileInput.files));
  }

  if (dropzone && fileInput) {
    dropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragover');
      if (event.dataTransfer?.files?.length) {
        setActiveFiles(event.dataTransfer.files);
      }
    });
  }

  updateFileList(activeFiles);
  renderResult({
    transcript: 'Upload a file to generate a transcript with speaker labels and timestamps.',
    summary: 'Summaries appear here after processing.',
    translation: 'Translations appear here after processing.',
    subtitles: 'Subtitle exports (SRT/VTT) will appear here.',
    json: { status: 'idle' }
  });
})();
