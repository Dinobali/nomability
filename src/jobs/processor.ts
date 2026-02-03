import { prisma } from '../lib/db.js';
import { getObjectStream } from '../lib/storage.js';
import { applyUsage } from '../lib/usage.js';
import { summarizeText, transcribeFile, translateText } from './ai.js';

const segmentsToSrt = (segments: Array<{ start: number; end: number; text: string }>) => {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds - Math.floor(seconds)) * 1000);
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
  };

  return segments
    .map((segment, index) => {
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${segment.text.trim()}\n`;
    })
    .join('\n');
};

const segmentsToVtt = (segments: Array<{ start: number; end: number; text: string }>) => {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds - Math.floor(seconds)) * 1000);
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis, 3)}`;
  };

  const body = segments
    .map((segment) => {
      return `${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${segment.text.trim()}\n`;
    })
    .join('\n');

  return `WEBVTT\n\n${body}`;
};

export const processJob = async (jobId: string) => {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { files: true }
  });

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'processing', progress: 10 }
  });

  const params = (job.params || {}) as Record<string, any>;
  const tasks = (job.tasks || {}) as Record<string, boolean>;

  let transcript = '';
  let rawResult: any = null;
  let durationSeconds = 0;

  for (const file of job.files) {
    const stream = await getObjectStream(file.bucket, file.r2Key);
    const result = await transcribeFile(stream, file.originalName, file.mimeType, {
      model: params.model || 'base',
      language: params.language || undefined,
      outputFormat: 'json',
      timestamps: params.timestamps || false
    });
    rawResult = result.raw;
    transcript = transcript ? `${transcript}\n\n${result.transcript}` : result.transcript;
    if (rawResult?.duration) {
      durationSeconds = Math.max(durationSeconds, rawResult.duration);
    } else if (Array.isArray(rawResult?.segments) && rawResult.segments.length) {
      const last = rawResult.segments[rawResult.segments.length - 1];
      durationSeconds = Math.max(durationSeconds, Number(last.end) || 0);
    }
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { progress: 65 }
  });

  let translation: string | undefined;
  if (tasks.translate && params.targetLanguage && transcript) {
    translation = await translateText(transcript, params.targetLanguage, params.language);
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { progress: 85 }
  });

  let summary: string | undefined;
  if (tasks.summarize && transcript) {
    summary = await summarizeText(transcript, params.summaryStyle || 'bullet');
  }

  const resultPayload: Record<string, any> = {
    transcript,
    translation,
    summary
  };

  if (rawResult && params.outputFormat) {
    if (params.outputFormat === 'json') {
      resultPayload.raw = rawResult;
    }
    if (params.outputFormat === 'srt' && Array.isArray(rawResult?.segments)) {
      resultPayload.subtitles = { srt: segmentsToSrt(rawResult.segments) };
    }
    if (params.outputFormat === 'vtt' && Array.isArray(rawResult?.segments)) {
      resultPayload.subtitles = { vtt: segmentsToVtt(rawResult.segments) };
    }
  }

  if (job.orgId) {
    const minutes = durationSeconds ? durationSeconds / 60 : 0;
    const usage = await applyUsage(job.orgId, jobId, minutes);
    resultPayload.usage = usage;
  }

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'completed',
      progress: 100,
      result: resultPayload
    }
  });

  return resultPayload;
};
