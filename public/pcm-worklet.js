// AudioWorklet: downsample mic input to 16 kHz, convert to 16-bit PCM,
// and post ~100 ms chunks to the main thread as ArrayBuffers.
class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetRate = opts.targetSampleRate || 16000;
    this.inputRate = opts.inputSampleRate || sampleRate;
    this.ratio = this.inputRate / this.targetRate;
    this._buffer = [];
    // 100 ms worth of 16 kHz samples.
    this.chunkSamples = Math.round(this.targetRate * 0.1);
    this._acc = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    // Simple averaging downsample.
    for (let i = 0; i < channel.length; i += this.ratio) {
      const idx = Math.floor(i);
      const next = Math.min(idx + Math.ceil(this.ratio), channel.length);
      let sum = 0;
      let count = 0;
      for (let j = idx; j < next; j++) {
        sum += channel[j];
        count++;
      }
      const sample = count > 0 ? sum / count : 0;
      this._buffer.push(sample);
    }

    while (this._buffer.length >= this.chunkSamples) {
      const slice = this._buffer.splice(0, this.chunkSamples);
      const pcm = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        let s = Math.max(-1, Math.min(1, slice[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
