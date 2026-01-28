(() => {
  const recordingPanel = document.querySelector('[data-recording-panel]');
  const livePanel = document.querySelector('[data-live-panel]');
  if (!recordingPanel && !livePanel) return;

  const JOBS_KEY = 'nmApiBase';
  const LIVE_WS_KEY = 'nmWhisperLiveWs';
  const LEGACY_LIVE_WS_KEY = 'realtimeEndpoint';

  const primaryApiInput = document.getElementById('api-base');

  const normalizeBase = (value) => (value || '').trim().replace(/\/+$/, '');
  const normalizeWs = (value) => (value || '').trim().replace(/\/+$/, '');

  const getStoredValue = (keys, normalizer) => {
    for (const key of keys) {
      const stored = localStorage.getItem(key);
      const normalized = normalizer(stored);
      if (normalized) return normalized;
    }
    return '';
  };

  const bindInput = (input, storageKey, normalizer, fallbackKeys = []) => {
    if (!input) return '';
    const stored = getStoredValue([storageKey, ...fallbackKeys], normalizer);
    if (stored) input.value = stored;
    const save = () => {
      const value = normalizer(input.value);
      if (value) {
        localStorage.setItem(storageKey, value);
      } else {
        localStorage.removeItem(storageKey);
      }
    };
    input.addEventListener('change', save);
    input.addEventListener('blur', save);
    return stored;
  };

  const getPrimaryApiBase = () => {
    const direct = normalizeBase(primaryApiInput?.value);
    if (direct) return direct;
    const placeholder = normalizeBase(primaryApiInput?.placeholder);
    if (placeholder) return placeholder;
    return normalizeBase(window.location.origin);
  };

  const getAuthHeaders = () => {
    const token = localStorage.getItem('nmAuthToken');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const escapeHtml = (text) =>
    String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const streamTranscription = async ({ base, blob, model, language, onUpdate, onReady }) => {
    const formData = new FormData();
    formData.append('file', blob, 'recording.webm');
    formData.append('model', model || 'base');
    if (language) formData.append('language', language);
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities', 'segment');

    const response = await fetch(`${base}/v1/transcriptions?stream=true`, {
      method: 'POST',
      headers: {
        Accept: 'application/x-ndjson'
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const error = new Error(errorText || `Transcription failed (${response.status})`);
      error.status = response.status;
      throw error;
    }

    if (onReady) onReady();

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json') && !contentType.includes('ndjson')) {
      const resultText = await response.text();
      try {
        const parsed = JSON.parse(resultText);
        const text = parsed.text || parsed.transcript || '';
        if (onUpdate) onUpdate(text);
        return text;
      } catch (error) {
        if (onUpdate) onUpdate(resultText);
        return resultText;
      }
    }

    if (!response.body) {
      const resultText = await response.text();
      try {
        const parsed = JSON.parse(resultText);
        const text = parsed.text || parsed.transcript || '';
        if (onUpdate) onUpdate(text);
        return text;
      } catch (error) {
        if (onUpdate) onUpdate(resultText);
        return resultText;
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    const handleLine = (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        return;
      }
      if (message.type === 'segment' && message.text) {
        fullText += message.text;
        if (onUpdate) onUpdate(fullText.trim());
      }
      if (message.type === 'done' && message.text && !fullText) {
        fullText = message.text;
        if (onUpdate) onUpdate(fullText.trim());
      }
      if (message.type === 'error') {
        throw new Error(message.error || 'Streaming error');
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(handleLine);
    }

    if (buffer.trim()) {
      handleLine(buffer);
    }

    return fullText.trim();
  };

  const pollJob = async (jobBase, jobId, attempt = 0) => {
    const response = await fetch(`${jobBase}/api/ai/jobs/${jobId}`, {
      headers: {
        ...getAuthHeaders()
      }
    });
    if (!response.ok) {
      throw new Error('Failed to fetch job status');
    }
    const data = await response.json();
    if (data.status === 'completed') {
      return data.result || data;
    }
    if (data.status === 'failed') {
      throw new Error(data.error || 'Job failed');
    }
    const delay = Math.min(2000 + attempt * 600, 9000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return pollJob(jobBase, jobId, attempt + 1);
  };

  const submitExtrasJob = async ({
    jobBase,
    blob,
    model,
    language,
    targetLanguage,
    summaryStyle,
    tasks
  }) => {
    const formData = new FormData();
    formData.append('files', blob, 'recording.webm');

    const payload = {
      model: model || 'base',
      language: language || '',
      targetLanguage: targetLanguage || '',
      summaryStyle: summaryStyle || 'bullet',
      outputFormat: 'txt',
      timestamps: false,
      tasks: {
        transcribe: true,
        translate: !!tasks.translate,
        summarize: !!tasks.summarize
      }
    };

    Object.entries(payload).forEach(([key, value]) => {
      if (typeof value === 'object') {
        formData.append(key, JSON.stringify(value));
      } else {
        formData.append(key, value);
      }
    });

    const response = await fetch(`${jobBase}/api/ai/jobs`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders()
      },
      body: formData
    });

    if (response.status === 401) {
      throw new Error('Login required for translation and summaries.');
    }
    if (response.status === 402) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Plan limit reached.');
    }
    if (response.status === 404 || response.status === 405) {
      throw new Error('Jobs endpoint is not available.');
    }
    if (!response.ok) {
      throw new Error(`Job request failed (${response.status})`);
    }

    const data = await response.json().catch(() => ({}));
    if (data.jobId) {
      return pollJob(jobBase, data.jobId);
    }
    return data.result || data;
  };

  const renderExtras = (outputs, result, tasks) => {
    if (outputs.transcript && (result.transcript || result.text)) {
      outputs.transcript.textContent = result.transcript || result.text || '';
    }
    if (tasks.summarize && outputs.summary) {
      const summary =
        result.summary ||
        result.summaryText ||
        result.summarized_text ||
        'No summary returned.';
      outputs.summary.textContent = summary;
    }
    if (tasks.translate && outputs.translation) {
      const translation =
        result.translation?.text ||
        result.translation ||
        result.translated_text ||
        result.translatedText ||
        'No translation returned.';
      outputs.translation.textContent = translation;
    }
  };

  const setupRecording = () => {
    if (!recordingPanel) return;
    const recStart = recordingPanel.querySelector('[data-rec-start]');
    const recStop = recordingPanel.querySelector('[data-rec-stop]');
    const recProcess = recordingPanel.querySelector('[data-rec-process]');
    const recClear = recordingPanel.querySelector('[data-rec-clear]');
    const recTimer = recordingPanel.querySelector('[data-rec-timer]');
    const recStatus = recordingPanel.querySelector('[data-rec-status]');
    const recProgressBar = recordingPanel.querySelector('[data-rec-progress-bar]');
    const recProgressLabel = recordingPanel.querySelector('[data-rec-progress-label]');
    const recAudio = recordingPanel.querySelector('[data-rec-audio]');
    const recModel = recordingPanel.querySelector('[data-rec-model]');
    const recLanguage = recordingPanel.querySelector('[data-rec-language]');
    const recTargetLanguage = recordingPanel.querySelector('[data-rec-target-language]');
    const recSummaryStyle = recordingPanel.querySelector('[data-rec-summary-style]');
    const recApiBase = recordingPanel.querySelector('[data-rec-api-base]');
    const recJobBase = recordingPanel.querySelector('[data-rec-job-base]');
    const recTaskTranslate = recordingPanel.querySelector('[data-rec-task="translate"]');
    const recTaskSummarize = recordingPanel.querySelector('[data-rec-task="summarize"]');

    const recTabs = Array.from(recordingPanel.querySelectorAll('[data-rec-tab]'));
    const recPanels = Array.from(recordingPanel.querySelectorAll('[data-rec-panel]'));
    const outputs = {
      transcript: recordingPanel.querySelector('[data-rec-panel="transcript"]'),
      summary: recordingPanel.querySelector('[data-rec-panel="summary"]'),
      translation: recordingPanel.querySelector('[data-rec-panel="translation"]')
    };

    if (!recStart || !recStop || !recProcess || !recTimer || !outputs.transcript) return;

    bindInput(recApiBase, JOBS_KEY, normalizeBase);
    bindInput(recJobBase, JOBS_KEY, normalizeBase);

    const syncRecApiBase = () => {
      if (!recApiBase) return;
      const base = getPrimaryApiBase();
      if (base && recApiBase.value !== base) {
        recApiBase.value = base;
      }
      if (primaryApiInput?.placeholder && !recApiBase.placeholder) {
        recApiBase.placeholder = primaryApiInput.placeholder;
      }
    };

    if (primaryApiInput) {
      primaryApiInput.addEventListener('change', syncRecApiBase);
      primaryApiInput.addEventListener('blur', syncRecApiBase);
    }

    let recorder = null;
    let recordStream = null;
    let audioChunks = [];
    let audioBlob = null;
    let audioUrl = '';
    let timerId = null;
    let recordingStart = 0;
    let isProcessing = false;
    let extrasPending = false;
    let transcriptPending = false;
    let extrasError = false;
    let transcriptError = false;
    let progressTimer = null;
    let progressValue = 0;

    const defaultTranscript = outputs.transcript.textContent || 'Record audio to see a streaming transcript.';
    const defaultSummary = outputs.summary?.textContent || 'Summaries appear after processing.';
    const defaultTranslation = outputs.translation?.textContent || 'Translations appear after processing.';

    const setStatus = (text) => {
      if (recStatus) recStatus.textContent = text;
    };

    const updateProgress = (value) => {
      progressValue = value;
      if (recProgressBar) recProgressBar.style.width = `${value}%`;
      if (recProgressLabel) recProgressLabel.textContent = `${value}%`;
    };

    const startProgress = () => {
      updateProgress(10);
      clearInterval(progressTimer);
      progressTimer = setInterval(() => {
        if (progressValue >= 90) return;
        updateProgress(Math.min(90, progressValue + Math.floor(Math.random() * 8 + 4)));
      }, 700);
    };

    const stopProgress = () => {
      clearInterval(progressTimer);
      updateProgress(100);
    };

    const resetTimer = () => {
      recTimer.textContent = '00:00';
    };

    const formatTime = (seconds) => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    };

    const updateTimer = () => {
      const seconds = Math.floor((Date.now() - recordingStart) / 1000);
      recTimer.textContent = formatTime(seconds);
    };

    const setOutputsDefault = () => {
      outputs.transcript.textContent = defaultTranscript;
      if (outputs.summary) outputs.summary.textContent = defaultSummary;
      if (outputs.translation) outputs.translation.textContent = defaultTranslation;
    };

    const updateButtons = () => {
      const hasOutput = outputs.transcript.textContent !== defaultTranscript;
      recProcess.disabled = !audioBlob || isProcessing;
      recClear.disabled = !audioBlob && !hasOutput;
    };

    const activateTab = (name) => {
      recTabs.forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.recTab === name);
      });
      recPanels.forEach((panel) => {
        panel.hidden = panel.dataset.recPanel !== name;
      });
    };

    recTabs.forEach((tab) => {
      tab.addEventListener('click', () => activateTab(tab.dataset.recTab));
    });

    activateTab('transcript');

    const cleanupAudio = () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
        audioUrl = '';
      }
      if (recAudio) {
        recAudio.removeAttribute('src');
        recAudio.load();
        recAudio.hidden = true;
      }
    };

    const startRecording = async () => {
      if (recorder || isProcessing) return;
      setStatus('Requesting microphone');
      try {
        recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(recordStream, {
          mimeType: 'audio/webm;codecs=opus'
        });
        audioChunks = [];
        audioBlob = null;
        cleanupAudio();
        recStart.disabled = true;
        recStop.disabled = false;
        recProcess.disabled = true;
        recClear.disabled = true;
        resetTimer();
        recordingStart = Date.now();
        timerId = setInterval(updateTimer, 1000);

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            audioChunks.push(event.data);
          }
        };

        recorder.onstop = () => {
          clearInterval(timerId);
          timerId = null;
          audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          if (recAudio) {
            audioUrl = URL.createObjectURL(audioBlob);
            recAudio.src = audioUrl;
            recAudio.hidden = false;
          }
          recProcess.disabled = false;
          recClear.disabled = false;
          setStatus('Ready to process');
        };

        recorder.start();
        setStatus('Recording');
      } catch (error) {
        setStatus('Microphone access failed');
      }
    };

    const stopRecording = () => {
      if (!recorder) return;
      recorder.stop();
      recorder = null;
      if (recordStream) {
        recordStream.getTracks().forEach((track) => track.stop());
        recordStream = null;
      }
      recStart.disabled = false;
      recStop.disabled = true;
    };

    const clearRecording = () => {
      if (recorder) stopRecording();
      audioChunks = [];
      audioBlob = null;
      cleanupAudio();
      resetTimer();
      clearInterval(progressTimer);
      updateProgress(0);
      setOutputsDefault();
      setStatus('Idle');
      recStart.disabled = false;
      recStop.disabled = true;
      updateButtons();
    };

    const processRecording = async () => {
      if (!audioBlob || isProcessing) return;
      const base = normalizeBase(recApiBase?.value) || getPrimaryApiBase();
      if (!base) {
        setStatus('Set FastWhisperAPI base URL');
        return;
      }

      isProcessing = true;
      extrasPending = false;
      transcriptPending = true;
      extrasError = false;
      transcriptError = false;
      startProgress();
      recStart.disabled = true;
      recProcess.disabled = true;
      setStatus('Streaming transcript');
      outputs.transcript.textContent = '';
      if (outputs.summary) outputs.summary.textContent = defaultSummary;
      if (outputs.translation) outputs.translation.textContent = defaultTranslation;

      const tasks = {
        translate: !!recTaskTranslate?.checked,
        summarize: !!recTaskSummarize?.checked
      };

      if (tasks.translate && !recTargetLanguage?.value.trim()) {
        if (outputs.translation) {
          outputs.translation.textContent = 'Set a target language to translate.';
        }
        tasks.translate = false;
      }

      const resolveJobBase = () =>
        normalizeBase(recJobBase?.value) || getStoredValue([JOBS_KEY], normalizeBase) || getPrimaryApiBase();

      const runExtrasJob = () => {
        const jobBase = resolveJobBase();
        if (!jobBase) {
          if (tasks.translate && outputs.translation) {
            outputs.translation.textContent = 'Set a Nomability API base URL to translate.';
          }
          if (tasks.summarize && outputs.summary) {
            outputs.summary.textContent = 'Set a Nomability API base URL to summarize.';
          }
          return null;
        }
        extrasPending = true;
        return submitExtrasJob({
          jobBase,
          blob: audioBlob,
          model: recModel?.value || 'base',
          language: recLanguage?.value || '',
          targetLanguage: recTargetLanguage?.value || '',
          summaryStyle: recSummaryStyle?.value || 'bullet',
          tasks
        })
          .then((result) => {
            renderExtras(outputs, result, tasks);
          })
          .catch((error) => {
            const message = error?.message || 'Extras failed.';
            if (tasks.summarize && outputs.summary) {
              outputs.summary.textContent = message;
            }
            if (tasks.translate && outputs.translation) {
              outputs.translation.textContent = message;
            }
            extrasError = true;
            setStatus('Extras failed');
          })
          .finally(() => {
            extrasPending = false;
            if (!transcriptPending) {
              if (!extrasError && !transcriptError) {
                setStatus('Completed');
              }
              stopProgress();
            }
          });
      };

      const runJobsOnly = async () => {
        const jobBase = resolveJobBase();
        if (!jobBase) {
          setStatus('Set API base URL');
          stopProgress();
          return;
        }
        setStatus('Uploading');
        try {
          const result = await submitExtrasJob({
            jobBase,
            blob: audioBlob,
            model: recModel?.value || 'base',
            language: recLanguage?.value || '',
            targetLanguage: recTargetLanguage?.value || '',
            summaryStyle: recSummaryStyle?.value || 'bullet',
            tasks
          });
          renderExtras(outputs, result, tasks);
          setStatus('Completed');
        } catch (error) {
          setStatus('Transcription failed');
          outputs.transcript.textContent = `Transcription failed: ${error.message || error}`;
        } finally {
          stopProgress();
        }
      };

      let extrasPromise = null;

      try {
        await streamTranscription({
          base,
          blob: audioBlob,
          model: recModel?.value || 'base',
          language: recLanguage?.value || '',
          onUpdate: (text) => {
            outputs.transcript.textContent = text;
          },
          onReady: () => {
            if (tasks.translate || tasks.summarize) {
              extrasPromise = runExtrasJob();
            }
          }
        });
        transcriptPending = false;
        if (extrasPending) {
          setStatus('Processing extras');
        } else {
          if (!extrasError && !transcriptError) {
            setStatus('Completed');
          }
          stopProgress();
        }
      } catch (error) {
        if (error?.status === 404) {
          transcriptPending = false;
          await runJobsOnly();
          isProcessing = false;
          recStart.disabled = false;
          updateButtons();
          return;
        }
        transcriptPending = false;
        transcriptError = true;
        setStatus('Transcription failed');
        outputs.transcript.textContent = `Transcription failed: ${error.message || error}`;
        stopProgress();
      } finally {
        isProcessing = false;
        recStart.disabled = false;
        updateButtons();
        if (extrasPromise) {
          await extrasPromise.catch(() => {});
        }
      }
    };

    recStart.addEventListener('click', startRecording);
    recStop.addEventListener('click', stopRecording);
    recProcess.addEventListener('click', processRecording);
    recClear.addEventListener('click', clearRecording);

    syncRecApiBase();
    clearRecording();
  };

  const setupWhisperLive = () => {
    if (!livePanel) return;
    const liveStart = livePanel.querySelector('[data-live-start]');
    const liveStop = livePanel.querySelector('[data-live-stop]');
    const liveClear = livePanel.querySelector('[data-live-clear]');
    const liveStatus = livePanel.querySelector('[data-live-status]');
    const liveOutput = livePanel.querySelector('[data-live-output]');
    const liveWsInput = livePanel.querySelector('[data-live-ws]');
    const liveLanguage = livePanel.querySelector('[data-live-language]');
    const liveModel = livePanel.querySelector('[data-live-model]');
    const liveVad = livePanel.querySelector('[data-live-vad]');

    if (!liveStart || !liveStop || !liveOutput || !liveWsInput) return;

    bindInput(liveWsInput, LIVE_WS_KEY, normalizeWs, [LEGACY_LIVE_WS_KEY]);

    let liveActive = false;
    let liveStream = null;
    let liveAudioContext = null;
    let liveSource = null;
    let liveProcessor = null;
    let liveGain = null;
    let liveSocket = null;
    let liveUid = null;
    let liveFinal = '';
    let livePartial = '';

    const setLiveStatus = (text) => {
      if (liveStatus) liveStatus.textContent = text;
    };

    const updateLiveButtons = () => {
      liveStart.disabled = liveActive;
      liveStop.disabled = !liveActive;
      liveClear.disabled = !liveActive && !liveFinal;
    };

    const updateLiveOutput = () => {
      const partial = livePartial
        ? `<span class="nm-live-partial">${livePartial}</span>\n`
        : '';
      liveOutput.innerHTML = `${liveFinal}${partial}` || 'Start WhisperLive to see real-time transcription.';
      liveOutput.scrollTop = liveOutput.scrollHeight;
    };

    const appendLiveFinal = (text) => {
      const safeText = escapeHtml(text.trim());
      if (!safeText) return;
      const timestamp = new Date().toLocaleTimeString();
      liveFinal += `<span class="nm-live-timestamp">[${timestamp}]</span> ${safeText}\n\n`;
      livePartial = '';
      updateLiveOutput();
    };

    const downsampleBuffer = (buffer, inputSampleRate, outputSampleRate) => {
      if (outputSampleRate >= inputSampleRate) {
        return new Float32Array(buffer);
      }
      const sampleRateRatio = inputSampleRate / outputSampleRate;
      const newLength = Math.round(buffer.length / sampleRateRatio);
      const result = new Float32Array(newLength);
      let offsetResult = 0;
      let offsetBuffer = 0;
      while (offsetResult < result.length) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
        let accum = 0;
        let count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
          accum += buffer[i];
          count += 1;
        }
        result[offsetResult] = count ? accum / count : 0;
        offsetResult += 1;
        offsetBuffer = nextOffsetBuffer;
      }
      return result;
    };

    const stopLive = () => {
      liveActive = false;
      setLiveStatus('Idle');

      if (liveProcessor) {
        liveProcessor.onaudioprocess = null;
        liveProcessor.disconnect();
        liveProcessor = null;
      }
      if (liveSource) {
        liveSource.disconnect();
        liveSource = null;
      }
      if (liveGain) {
        liveGain.disconnect();
        liveGain = null;
      }
      if (liveAudioContext) {
        liveAudioContext.close();
        liveAudioContext = null;
      }
      if (liveStream) {
        liveStream.getTracks().forEach((track) => track.stop());
        liveStream = null;
      }
      if (liveSocket) {
        const socket = liveSocket;
        liveSocket = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState === WebSocket.OPEN) {
          socket.send('END_OF_AUDIO');
          setTimeout(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.close();
            }
          }, 800);
        } else {
          socket.close();
        }
      }

      updateLiveButtons();
    };

    const startLive = async () => {
      if (liveActive) return;
      const wsValue = normalizeWs(liveWsInput.value) || getStoredValue([LIVE_WS_KEY, LEGACY_LIVE_WS_KEY], normalizeWs);
      if (!wsValue) {
        setLiveStatus('Set WhisperLive WebSocket');
        return;
      }
      let wsUrl;
      try {
        wsUrl = new URL(wsValue);
      } catch (error) {
        setLiveStatus('Invalid WebSocket URL');
        return;
      }
      if (wsUrl.protocol !== 'ws:' && wsUrl.protocol !== 'wss:') {
        setLiveStatus('WebSocket must start with ws:// or wss://');
        return;
      }

      try {
        liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        liveActive = true;
        liveFinal = '';
        livePartial = '';
        updateLiveOutput();
        updateLiveButtons();
        setLiveStatus('Connecting');

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        liveAudioContext = new AudioContextClass();
        await liveAudioContext.resume();
        liveSource = liveAudioContext.createMediaStreamSource(liveStream);
        liveProcessor = liveAudioContext.createScriptProcessor(4096, 1, 1);
        liveGain = liveAudioContext.createGain();
        liveGain.gain.value = 0;

        liveSource.connect(liveProcessor);
        liveProcessor.connect(liveGain);
        liveGain.connect(liveAudioContext.destination);

        liveSocket = new WebSocket(wsValue);
        liveSocket.binaryType = 'arraybuffer';
        liveUid = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

        liveSocket.onopen = () => {
          const language = (liveLanguage?.value || '').trim() || null;
          const model = liveModel?.value || 'base';
          const config = {
            uid: liveUid,
            language,
            lang: language,
            task: 'transcribe',
            model,
            use_vad: !!liveVad?.checked
          };
          liveSocket.send(JSON.stringify(config));
          setLiveStatus('Live');
        };

        liveSocket.onmessage = (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch (error) {
            return;
          }
          if (message.status === 'ERROR' && message.message) {
            setLiveStatus(message.message);
            return;
          }
          if (Array.isArray(message.segments)) {
            message.segments.forEach((segment) => {
              if (!segment || !segment.text) return;
              if (segment.completed) {
                appendLiveFinal(segment.text);
              } else {
                livePartial = escapeHtml(segment.text.trim());
                updateLiveOutput();
              }
            });
          }
        };

        liveSocket.onerror = () => {
          if (liveActive) {
            setLiveStatus('Realtime connection error');
            stopLive();
          }
        };

        liveSocket.onclose = () => {
          if (liveActive) {
            setLiveStatus('Realtime connection closed');
            stopLive();
          }
        };

        liveProcessor.onaudioprocess = (event) => {
          if (!liveActive || !liveSocket || liveSocket.readyState !== WebSocket.OPEN) return;
          const inputData = event.inputBuffer.getChannelData(0);
          const downsampled = downsampleBuffer(inputData, liveAudioContext.sampleRate, 16000);
          if (!downsampled.length) return;
          liveSocket.send(downsampled.buffer);
        };
      } catch (error) {
        setLiveStatus('Microphone access failed');
        stopLive();
      }
    };

    const clearLive = () => {
      liveFinal = '';
      livePartial = '';
      updateLiveOutput();
      updateLiveButtons();
    };

    liveStart.addEventListener('click', startLive);
    liveStop.addEventListener('click', stopLive);
    liveClear.addEventListener('click', clearLive);

    updateLiveButtons();
    updateLiveOutput();
  };

  setupRecording();
  setupWhisperLive();
})();
