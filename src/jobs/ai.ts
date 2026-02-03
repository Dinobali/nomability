import fetch, { Headers } from 'node-fetch';
import FormData from 'form-data';
import { env } from '../config/env.js';
import { Readable } from 'node:stream';

export type TranscribePayload = {
  model: string;
  language?: string;
  outputFormat: 'txt' | 'srt' | 'vtt' | 'json';
  timestamps?: boolean;
};

const mapResponseFormat = (outputFormat: TranscribePayload['outputFormat']) => {
  if (outputFormat === 'json') return 'verbose_json';
  if (outputFormat === 'srt') return 'srt';
  if (outputFormat === 'vtt') return 'vtt';
  return 'text';
};

export const transcribeFile = async (fileStream: Readable, filename: string, mimeType: string, payload: TranscribePayload) => {
  const form = new FormData();
  form.append('file', fileStream, { filename, contentType: mimeType });
  form.append('model', payload.model);
  if (payload.language) form.append('language', payload.language);
  form.append('response_format', mapResponseFormat(payload.outputFormat));
  if (payload.timestamps) {
    form.append('timestamp_granularities', 'segment');
  }

  const url = `${env.AI_WORKER_BASE_URL}${env.AI_WORKER_TRANSCRIBE_ENDPOINT}`;
  const headers = new Headers(form.getHeaders());

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: form
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Transcribe failed (${response.status}): ${message}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = (await response.json()) as { text?: string; transcript?: string };
    const transcript = data.text || data.transcript || '';
    return { transcript, raw: data };
  }

  const text = await response.text();
  return { transcript: text, raw: text };
};

export const callOllama = async (prompt: string, model: string) => {
  if (!env.OLLAMA_BASE_URL) {
    throw new Error('OLLAMA_BASE_URL is not set');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Ollama failed (${response.status}): ${message}`);
    }

    const data = (await response.json()) as { response?: string };
    return (data.response || '').trim();
  } finally {
    clearTimeout(timeout);
  }
};

export const translateText = async (text: string, targetLanguage: string, sourceLanguage?: string) => {
  const sourceLine = sourceLanguage ? ` from ${sourceLanguage}` : '';
  const prompt = `Translate the following text${sourceLine} to ${targetLanguage}. Return only the translated text.\n\n${text}`;
  return callOllama(prompt, env.OLLAMA_MODEL);
};

export const summarizeText = async (text: string, style = 'bullet') => {
  const normalized = (style || 'bullet').toString().toLowerCase();
  const key = normalized.replace(/[\s_]+/g, '-');
  const isProtocol = key.includes('protocol') || key.includes('protokoll');
  const isDetailed =
    key.includes('detailed') ||
    key.includes('ausfuehrlich') ||
    key.includes('ausführlich') ||
    key.includes('long');
  const isCompact =
    key.includes('compact') ||
    key.includes('kompakt') ||
    key.includes('knapp') ||
    key.includes('kurz') ||
    key.includes('short');
  let prompt;

  if (isProtocol && isDetailed) {
    prompt =
      'Create detailed meeting minutes (Protokoll) from the transcript. ' +
      'Use clear headings and bullet points. Include discussion highlights, decisions, tasks/assignments, and open questions if mentioned. ' +
      'If details are not mentioned, omit them. Write in the same language as the transcript. Return only the minutes.\n\n' +
      text;
  } else if (isProtocol || isCompact) {
    prompt =
      'Create concise meeting minutes (Protokoll) from the transcript in 5-8 bullet points. ' +
      'Focus on main topics, decisions, and tasks. Write in the same language as the transcript. Return only the minutes.\n\n' +
      text;
  } else if (key === 'executive') {
    prompt =
      'Write an executive summary of the following transcript in 5-8 sentences. ' +
      'Focus on the main outcomes, risks, and decisions. Write in the same language as the transcript. Return only the summary.\n\n' +
      text;
  } else if (key === 'action' || key === 'action-items' || key === 'actions') {
    prompt =
      'Extract the action items from the following transcript. Return a concise bullet list. ' +
      'Write in the same language as the transcript. Return only the action items.\n\n' +
      text;
  } else {
    prompt =
      'Summarize the following transcript in concise bullet points. ' +
      'Write in the same language as the transcript. Return only the summary.\n\n' +
      text;
  }
  return callOllama(prompt, env.OLLAMA_SUMMARY_MODEL);
};
