(() => {
  const recordingPanel = document.querySelector('[data-recording-panel]');
  const livePanel = document.querySelector('[data-live-panel]');
  if (!recordingPanel && !livePanel) return;

  const AI_BASE_URL = 'https://ai.nomability.net';
  const JOBS_BASE_URL = window.location.origin;
  const WHISPERLIVE_WS_URL = 'wss://ai.nomability.net/ws/whisperlive';

  const getAuthHeaders = () => {
    const token = localStorage.getItem('nmAuthToken');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const checkEntitlement = async (jobBase) => {
    const headers = getAuthHeaders();
    if (!headers.Authorization) {
      return { allowed: false, message: 'Login required to start a job.' };
    }
    try {
      const response = await fetch(`${jobBase}/api/ai/entitlement`, { headers });
      if (response.status === 401) {
        return { allowed: false, message: 'Login required to start a job.' };
      }
      if (!response.ok) {
        return { allowed: true };
      }
      const data = await response.json().catch(() => ({}));
      if (data?.allowed === false) {
        return { allowed: false, message: data.message || 'Plan limit reached. Please top up credits or subscribe.' };
      }
      return { allowed: true };
    } catch (error) {
      return { allowed: true };
    }
  };

  const escapeHtml = (text) =>
    String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const downloadFile = ({ content, filename, mime }) => {
    if (!content) return false;
    const blob = new Blob([content], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || 'nomability-output.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return true;
  };

  const normalizeOutput = (value, placeholder) => {
    const text = String(value || '').trim();
    if (!text) return '';
    if (placeholder && text === placeholder.trim()) return '';
    return text;
  };

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
    const entitlement = await checkEntitlement(jobBase);
    if (!entitlement.allowed) {
      throw new Error(entitlement.message || 'Plan limit reached.');
    }

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
    const recTaskTranslate = recordingPanel.querySelector('[data-rec-task="translate"]');
    const recTaskSummarize = recordingPanel.querySelector('[data-rec-task="summarize"]');
    const recDownloadButtons = Array.from(
      recordingPanel.querySelectorAll('[data-rec-download]')
    );
    const recPresetButtons = Array.from(
      recordingPanel.querySelectorAll('[data-rec-preset]')
    );

    const recTabs = Array.from(recordingPanel.querySelectorAll('[data-rec-tab]'));
    const recPanels = Array.from(recordingPanel.querySelectorAll('[data-rec-panel]'));
    const outputs = {
      transcript: recordingPanel.querySelector('[data-rec-panel="transcript"]'),
      summary: recordingPanel.querySelector('[data-rec-panel="summary"]'),
      translation: recordingPanel.querySelector('[data-rec-panel="translation"]')
    };

    if (!recStart || !recStop || !recProcess || !recTimer || !outputs.transcript) return;

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
    let recRawResult = null;

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

    const setRecPresetActive = (activeButton) => {
      recPresetButtons.forEach((button) => {
        const isActive = button === activeButton;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    };

    const applyRecPreset = (preset) => {
      if (recTaskTranslate) recTaskTranslate.checked = false;
      if (recTaskSummarize) recTaskSummarize.checked = false;
      if (recSummaryStyle) recSummaryStyle.value = 'bullet';
      if (recTargetLanguage) recTargetLanguage.value = '';

      if (preset === 'summary') {
        if (recTaskSummarize) recTaskSummarize.checked = true;
        if (recSummaryStyle) recSummaryStyle.value = 'executive';
      } else if (preset === 'translate') {
        if (recTaskTranslate) recTaskTranslate.checked = true;
        if (recTargetLanguage && !recTargetLanguage.value.trim()) {
          recTargetLanguage.value = 'en';
        }
      }
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

    const getRecOutputs = () => ({
      transcript: normalizeOutput(outputs.transcript?.textContent, defaultTranscript),
      summary: normalizeOutput(outputs.summary?.textContent, defaultSummary),
      translation: normalizeOutput(outputs.translation?.textContent, defaultTranslation)
    });

    const updateRecResult = (updates) => {
      recRawResult = { ...(recRawResult || {}), ...(updates || {}) };
    };

    const getRecDownloadPayload = (type) => {
      const { transcript, summary, translation } = getRecOutputs();
      const translationText =
        translation ||
        recRawResult?.translation?.text ||
        recRawResult?.translation ||
        recRawResult?.translated_text ||
        recRawResult?.translatedText ||
        '';
      const summaryText =
        summary ||
        recRawResult?.summary ||
        recRawResult?.summaryText ||
        recRawResult?.summarized_text ||
        '';
      const transcriptText = transcript || recRawResult?.transcript || recRawResult?.text || '';

      if (type === 'json') {
        const payload = recRawResult
          ? {
              ...recRawResult,
              transcript: transcriptText || recRawResult.transcript || recRawResult.text || '',
              summary: summaryText || recRawResult.summary || recRawResult.summaryText || '',
              translation: translationText || recRawResult.translation || ''
            }
          : {
              transcript: transcriptText,
              summary: summaryText,
              translation: translationText
            };
        return {
          content: JSON.stringify(payload, null, 2),
          filename: 'nomability-recording.json',
          mime: 'application/json'
        };
      }

      if (type === 'translation') {
        return {
          content: translationText,
          filename: 'nomability-translation.txt',
          mime: 'text/plain'
        };
      }

      if (type === 'summary') {
        return {
          content: summaryText,
          filename: 'nomability-summary.txt',
          mime: 'text/plain'
        };
      }

      if (type === 'subtitles') {
        const subtitles =
          recRawResult?.subtitles?.srt || recRawResult?.subtitles || recRawResult?.srt || '';
        return {
          content: subtitles,
          filename: 'nomability-subtitles.srt',
          mime: 'text/plain'
        };
      }

      return {
        content: transcriptText,
        filename: 'nomability-transcript.txt',
        mime: 'text/plain'
      };
    };

    recDownloadButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const payload = getRecDownloadPayload(button.dataset.recDownload);
        if (!downloadFile(payload)) {
          setStatus('No output available for download.');
        }
      });
    });

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

    recPresetButtons.forEach((button) => {
      button.addEventListener('click', () => {
        applyRecPreset(button.dataset.recPreset);
        setRecPresetActive(button);
      });
    });

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
        recRawResult = null;
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
      recRawResult = null;
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
      const base = AI_BASE_URL;

      isProcessing = true;
      recRawResult = null;
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

      const resolveJobBase = () => JOBS_BASE_URL;

      const runExtrasJob = () => {
        const jobBase = resolveJobBase();
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
            updateRecResult(result);
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
          updateRecResult(result);
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
            updateRecResult({ transcript: text });
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

    clearRecording();
  };

  const setupWhisperLive = () => {
    if (!livePanel) return;
    const liveStart = livePanel.querySelector('[data-live-start]');
    const liveStop = livePanel.querySelector('[data-live-stop]');
    const liveClear = livePanel.querySelector('[data-live-clear]');
    const liveProcess = livePanel.querySelector('[data-live-process]');
    const liveStatus = livePanel.querySelector('[data-live-status]');
    const liveLanguage = livePanel.querySelector('[data-live-language]');
    const liveModel = livePanel.querySelector('[data-live-model]');
    const liveVad = livePanel.querySelector('[data-live-vad]');
    const liveTargetLanguage = livePanel.querySelector('[data-live-target-language]');
    const liveSummaryStyle = livePanel.querySelector('[data-live-summary-style]');
    const liveTaskTranslate = livePanel.querySelector('[data-live-task="translate"]');
    const liveTaskSummarize = livePanel.querySelector('[data-live-task="summarize"]');
    const liveDownloadButtons = Array.from(
      livePanel.querySelectorAll('[data-live-download]')
    );
    const livePresetButtons = Array.from(
      livePanel.querySelectorAll('[data-live-preset]')
    );
    const liveTabs = Array.from(livePanel.querySelectorAll('[data-live-tab]'));
    const livePanels = Array.from(livePanel.querySelectorAll('[data-live-panel]'));
    const outputs = {
      transcript: livePanel.querySelector('[data-live-panel="transcript"]'),
      summary: livePanel.querySelector('[data-live-panel="summary"]'),
      translation: livePanel.querySelector('[data-live-panel="translation"]')
    };

    if (!liveStart || !liveStop || !outputs.transcript) return;

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
    let lastLiveFinalText = '';
    let liveSeenSegmentKeys = new Set();
    let liveRecorder = null;
    let liveChunks = [];
    let liveAudioBlob = null;
    let liveProcessing = false;
    let liveRawResult = null;

    const defaultLiveTranscript =
      outputs.transcript.textContent || 'Start live transcription to see real-time transcription.';
    const defaultLiveSummary =
      outputs.summary?.textContent || 'Summaries appear after processing.';
    const defaultLiveTranslation =
      outputs.translation?.textContent || 'Translations appear after processing.';

    const setLiveStatus = (text) => {
      if (liveStatus) liveStatus.textContent = text;
    };

    const updateLiveButtons = () => {
      liveStart.disabled = liveActive || liveProcessing;
      liveStop.disabled = !liveActive;
      liveClear.disabled = !liveActive && !liveFinal;
      if (liveProcess) {
        liveProcess.disabled = liveActive || liveProcessing || !liveAudioBlob;
      }
    };

    const updateLiveOutput = () => {
      const partial = livePartial
        ? `<span class="nm-live-partial">${livePartial}</span>\n`
        : '';
      outputs.transcript.innerHTML = `${liveFinal}${partial}` || defaultLiveTranscript;
      outputs.transcript.scrollTop = outputs.transcript.scrollHeight;
    };

    const setLivePresetActive = (activeButton) => {
      livePresetButtons.forEach((button) => {
        const isActive = button === activeButton;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    };

    const applyLivePreset = (preset) => {
      if (liveTaskTranslate) liveTaskTranslate.checked = false;
      if (liveTaskSummarize) liveTaskSummarize.checked = false;
      if (liveSummaryStyle) liveSummaryStyle.value = 'bullet';
      if (liveTargetLanguage) liveTargetLanguage.value = '';

      if (preset === 'summary') {
        if (liveTaskSummarize) liveTaskSummarize.checked = true;
        if (liveSummaryStyle) liveSummaryStyle.value = 'executive';
      } else if (preset === 'translate') {
        if (liveTaskTranslate) liveTaskTranslate.checked = true;
        if (liveTargetLanguage && !liveTargetLanguage.value.trim()) {
          liveTargetLanguage.value = 'en';
        }
      }
    };

    const normalizeLiveText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    const getSegmentTimeKey = (segment) => {
      const start = segment?.start ?? segment?.start_ts ?? segment?.start_time ?? null;
      const end = segment?.end ?? segment?.end_ts ?? segment?.end_time ?? null;
      if (start === null && end === null) return '';
      const startKey = start === null || start === undefined ? '' : String(start);
      const endKey = end === null || end === undefined ? '' : String(end);
      return `${startKey}-${endKey}`;
    };

    const appendLiveFinal = (text) => {
      const rawText = text.trim();
      if (!rawText) return;
      const normalized = normalizeLiveText(rawText);
      if (!normalized) return;
      if (normalized === lastLiveFinalText) {
        return;
      }
      lastLiveFinalText = normalized;
      const safeText = escapeHtml(rawText);
      liveFinal += `${safeText}\n\n`;
      livePartial = '';
      updateLiveOutput();
    };

    const setLiveOutputsDefault = () => {
      outputs.transcript.textContent = defaultLiveTranscript;
      if (outputs.summary) outputs.summary.textContent = defaultLiveSummary;
      if (outputs.translation) outputs.translation.textContent = defaultLiveTranslation;
    };

    const getLiveOutputs = () => ({
      transcript: normalizeOutput(outputs.transcript?.textContent, defaultLiveTranscript),
      summary: normalizeOutput(outputs.summary?.textContent, defaultLiveSummary),
      translation: normalizeOutput(outputs.translation?.textContent, defaultLiveTranslation)
    });

    const updateLiveResult = (updates) => {
      liveRawResult = { ...(liveRawResult || {}), ...(updates || {}) };
    };

    const activateLiveTab = (name) => {
      liveTabs.forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.liveTab === name);
      });
      livePanels.forEach((panel) => {
        panel.hidden = panel.dataset.livePanel !== name;
      });
    };

    const getLiveTranscriptText = () => {
      if (!liveFinal) return '';
      const wrapper = document.createElement('div');
      wrapper.innerHTML = liveFinal;
      return (wrapper.textContent || '').trim();
    };

    const getLiveDownloadPayload = (type) => {
      const { transcript, summary, translation } = getLiveOutputs();
      const transcriptText = transcript || getLiveTranscriptText();
      const translationText =
        translation ||
        liveRawResult?.translation?.text ||
        liveRawResult?.translation ||
        liveRawResult?.translated_text ||
        liveRawResult?.translatedText ||
        '';
      const summaryText =
        summary ||
        liveRawResult?.summary ||
        liveRawResult?.summaryText ||
        liveRawResult?.summarized_text ||
        '';
      if (type === 'json') {
        const payload = {
          transcript: transcriptText,
          summary: summaryText,
          translation: translationText,
          model: liveModel?.value || 'base',
          language: (liveLanguage?.value || '').trim() || null
        };
        return {
          content: JSON.stringify(payload, null, 2),
          filename: 'nomability-live.json',
          mime: 'application/json'
        };
      }
      if (type === 'translation') {
        return {
          content: translationText,
          filename: 'nomability-translation.txt',
          mime: 'text/plain'
        };
      }
      if (type === 'summary') {
        return {
          content: summaryText,
          filename: 'nomability-summary.txt',
          mime: 'text/plain'
        };
      }
      if (type === 'subtitles') {
        return {
          content: '',
          filename: 'nomability-subtitles.srt',
          mime: 'text/plain'
        };
      }
      return {
        content: transcriptText,
        filename: 'nomability-live-transcript.txt',
        mime: 'text/plain'
      };
    };

    liveDownloadButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const payload = getLiveDownloadPayload(button.dataset.liveDownload);
        if (!downloadFile(payload)) {
          setLiveStatus('No output available for download.');
        }
      });
    });

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

    const processLive = async () => {
      if (!liveAudioBlob || liveProcessing) return;
      const tasks = {
        translate: !!liveTaskTranslate?.checked,
        summarize: !!liveTaskSummarize?.checked
      };

      if (tasks.translate && !liveTargetLanguage?.value.trim()) {
        if (outputs.translation) {
          outputs.translation.textContent = 'Set a target language to translate.';
        }
        tasks.translate = false;
      }

      if (!tasks.translate && !tasks.summarize) {
        setLiveStatus('Select translate or summarize');
        return;
      }

      liveProcessing = true;
      updateLiveButtons();
      setLiveStatus('Processing extras');
      if (tasks.summarize && outputs.summary) {
        outputs.summary.textContent = defaultLiveSummary;
      }
      if (tasks.translate && outputs.translation) {
        outputs.translation.textContent = defaultLiveTranslation;
      }

      try {
        const result = await submitExtrasJob({
          jobBase: JOBS_BASE_URL,
          blob: liveAudioBlob,
          model: liveModel?.value || 'base',
          language: liveLanguage?.value || '',
          targetLanguage: liveTargetLanguage?.value || '',
          summaryStyle: liveSummaryStyle?.value || 'bullet',
          tasks
        });
        renderExtras(
          { summary: outputs.summary, translation: outputs.translation },
          result,
          tasks
        );
        updateLiveResult(result);
        if (tasks.summarize && outputs.summary) {
          activateLiveTab('summary');
        } else if (tasks.translate && outputs.translation) {
          activateLiveTab('translation');
        }
        setLiveStatus('Completed');
      } catch (error) {
        const message = error?.message || 'Extras failed.';
        if (tasks.summarize && outputs.summary) {
          outputs.summary.textContent = message;
        }
        if (tasks.translate && outputs.translation) {
          outputs.translation.textContent = message;
        }
        setLiveStatus('Extras failed');
      } finally {
        liveProcessing = false;
        updateLiveButtons();
      }
    };

    const stopLive = () => {
      liveActive = false;
      setLiveStatus('Idle');

      if (liveRecorder) {
        const recorder = liveRecorder;
        liveRecorder = null;
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      }
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
      const wsValue = WHISPERLIVE_WS_URL;
      let wsUrl;
      try {
        wsUrl = new URL(wsValue);
      } catch (error) {
        setLiveStatus('Invalid WebSocket URL');
        return;
      }
      if (wsUrl.protocol !== 'ws:' && wsUrl.protocol !== 'wss:') {
        setLiveStatus('WebSocket must be wss://ai.nomability.net/ws/whisperlive');
        return;
      }

      try {
        liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        liveActive = true;
        liveFinal = '';
        livePartial = '';
        lastLiveFinalText = '';
        liveSeenSegmentKeys = new Set();
        liveChunks = [];
        liveAudioBlob = null;
        liveRawResult = null;
        setLiveOutputsDefault();
        updateLiveOutput();
        updateLiveButtons();
        setLiveStatus('Connecting');

        if (window.MediaRecorder) {
          try {
            liveRecorder = new MediaRecorder(liveStream, {
              mimeType: 'audio/webm;codecs=opus'
            });
          } catch (error) {
            liveRecorder = new MediaRecorder(liveStream);
          }

          liveRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
              liveChunks.push(event.data);
            }
          };

          liveRecorder.onstop = (event) => {
            const mimeType = event?.target?.mimeType || 'audio/webm';
            if (liveChunks.length) {
              liveAudioBlob = new Blob(liveChunks, { type: mimeType });
            } else {
              liveAudioBlob = null;
            }
            if (liveAudioBlob) {
              setLiveStatus('Ready to process');
            }
            updateLiveButtons();
          };

          liveRecorder.start();
        }

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
                const timeKey = getSegmentTimeKey(segment);
                if (timeKey) {
                  const normalized = normalizeLiveText(segment.text);
                  const segmentKey = `${timeKey}:${normalized}`;
                  if (liveSeenSegmentKeys.has(segmentKey)) return;
                  liveSeenSegmentKeys.add(segmentKey);
                  if (liveSeenSegmentKeys.size > 2000) {
                    liveSeenSegmentKeys = new Set(Array.from(liveSeenSegmentKeys).slice(-1000));
                  }
                }
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
      lastLiveFinalText = '';
      liveSeenSegmentKeys = new Set();
      liveChunks = [];
      liveAudioBlob = null;
      liveRawResult = null;
      liveProcessing = false;
      setLiveOutputsDefault();
      if (liveTabs.length) {
        activateLiveTab('transcript');
      }
      updateLiveOutput();
      updateLiveButtons();
    };

    liveStart.addEventListener('click', startLive);
    liveStop.addEventListener('click', stopLive);
    liveClear.addEventListener('click', clearLive);
    if (liveProcess) {
      liveProcess.addEventListener('click', processLive);
    }
    livePresetButtons.forEach((button) => {
      button.addEventListener('click', () => {
        applyLivePreset(button.dataset.livePreset);
        setLivePresetActive(button);
      });
    });
    liveTabs.forEach((tab) => {
      tab.addEventListener('click', () => activateLiveTab(tab.dataset.liveTab));
    });

    updateLiveButtons();
    updateLiveOutput();
    if (liveTabs.length) {
      activateLiveTab('transcript');
    }
  };

  setupRecording();
  setupWhisperLive();
})();
