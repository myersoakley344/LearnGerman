import {
  ABSOLUTE_SPEECH_THRESHOLD,
  AUDIO_SAMPLE_RATE,
  RELATIVE_SPEECH_THRESHOLD,
  SILENCE_PADDING_MS,
  SILENCE_WINDOW_MS
} from "./state.js";

export function chooseRecorderMimeType() {
  if (!window.MediaRecorder) return "";

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4"
  ];

  return candidates.find(type =>
    MediaRecorder.isTypeSupported(type)
  ) || "";
}

export async function requestAudioStream() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error(
      "Dieser Browser unterstützt keine Audioaufnahme. " +
      "Bitte Chrome auf Android verwenden."
    );
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
}

export async function convertBlobToWav(blob) {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("Web Audio API ist nicht verfügbar.");
  }

  const context = new AudioContextClass();

  try {
    const input = await context.decodeAudioData(
      await blob.arrayBuffer()
    );

    const outputRate = AUDIO_SAMPLE_RATE;
    const ratio = input.sampleRate / outputRate;
    const outputLength = Math.max(
      1,
      Math.ceil(input.length / ratio)
    );

    const mono = new Float32Array(outputLength);

    for (let channel = 0; channel < input.numberOfChannels; channel++) {
      const source = input.getChannelData(channel);

      for (let index = 0; index < outputLength; index++) {
        const sourcePosition = index * ratio;
        const left = Math.min(
          Math.floor(sourcePosition),
          source.length - 1
        );
        const right = Math.min(left + 1, source.length - 1);
        const fraction = sourcePosition - left;

        const sample =
          source[left] * (1 - fraction) +
          source[right] * fraction;

        mono[index] += sample / input.numberOfChannels;
      }
    }

    return encodeWav(mono, outputRate);
  } finally {
    await context.close();
  }
}

export async function trimSilenceFromWav(wavBlob) {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("Web Audio API ist nicht verfügbar.");
  }

  const context = new AudioContextClass();

  try {
    const decoded = await context.decodeAudioData(
      await wavBlob.arrayBuffer()
    );

    const sampleRate = decoded.sampleRate;
    const samples = decoded.getChannelData(0);

    const windowSize = Math.max(
      1,
      Math.round(sampleRate * SILENCE_WINDOW_MS / 1000)
    );

    const windows = [];

    for (let start = 0; start < samples.length; start += windowSize) {
      const end = Math.min(start + windowSize, samples.length);
      let sumSquares = 0;

      for (let index = start; index < end; index++) {
        sumSquares += samples[index] * samples[index];
      }

      windows.push({
        start,
        end,
        rms: Math.sqrt(sumSquares / Math.max(1, end - start))
      });
    }

    const peakRms = windows.reduce(
      (peak, window) => Math.max(peak, window.rms),
      0
    );

    const threshold = Math.max(
      ABSOLUTE_SPEECH_THRESHOLD,
      peakRms * RELATIVE_SPEECH_THRESHOLD
    );

    const activeWindows = windows.filter(
      window => window.rms >= threshold
    );

    const originalDurationMs =
      decoded.length / sampleRate * 1000;

    if (
      peakRms < ABSOLUTE_SPEECH_THRESHOLD ||
      activeWindows.length < 2
    ) {
      return {
        blob: wavBlob,
        hasSpeech: false,
        originalDurationMs,
        trimmedDurationMs: originalDurationMs,
        trimStartMs: 0,
        trimEndMs: 0,
        threshold
      };
    }

    const paddingSamples = Math.round(
      sampleRate * SILENCE_PADDING_MS / 1000
    );

    const startSample = Math.max(
      0,
      activeWindows[0].start - paddingSamples
    );

    const endSample = Math.min(
      decoded.length,
      activeWindows[activeWindows.length - 1].end + paddingSamples
    );

    const frameCount = endSample - startSample;

    if (frameCount <= 0) {
      return {
        blob: wavBlob,
        hasSpeech: false,
        originalDurationMs,
        trimmedDurationMs: originalDurationMs,
        trimStartMs: 0,
        trimEndMs: 0,
        threshold
      };
    }

    const monoOutput = new Float32Array(frameCount);
    monoOutput.set(
      decoded.getChannelData(0).slice(startSample, endSample)
    );

    const trimmedBlob = encodeWav(monoOutput, sampleRate);

    return {
      blob: trimmedBlob,
      hasSpeech: true,
      originalDurationMs,
      trimmedDurationMs: frameCount / sampleRate * 1000,
      trimStartMs: startSample / sampleRate * 1000,
      trimEndMs: (decoded.length - endSample) / sampleRate * 1000,
      threshold
    };
  } finally {
    await context.close();
  }
}

export function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;

  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    const value = clipped < 0
      ? clipped * 0x8000
      : clipped * 0x7fff;

    view.setInt16(offset, value, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

export async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
