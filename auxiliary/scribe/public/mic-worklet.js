/**
 * Microphone capture worklet.
 *
 * Runs on the audio render thread, so it must be cheap and must never allocate
 * per sample. It does two things: downsample 48 kHz to the 16 kHz the speech
 * model wants, and report a level so the main thread can do endpointing without
 * ever touching raw audio.
 *
 * ScriptProcessorNode would have been simpler and is deprecated for good reason:
 * it runs on the main thread and drops frames whenever the document re-renders,
 * which for this app is constantly.
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Keep the ratio fractional. Many devices run at 44.1 kHz; rounding its
    // 2.75625 ratio to 3 silently produced 14.7 kHz audio that the server then
    // played back as 16 kHz. Weighted box bins preserve the exact long-run
    // output rate while remaining cheap enough for the render thread.
    this.ratio = sampleRate / 16000;
    this.acc = 0;
    this.accWeight = 0;
    this.remaining = this.ratio;
    this.out = new Float32Array(1024);
    this.outN = 0;
    // process() runs every 128 frames, which at 48 kHz is about 375 times a
    // second. Posting a level message that often floods the main thread of an
    // app whose entire premise is staying smooth. Endpointing needs tens of
    // milliseconds of resolution, not three, so coalesce to ~60 Hz and send the
    // loudest reading in each window rather than the most recent one (a peak
    // picker must not miss the peak).
    this.levelEvery = Math.max(1, Math.round(sampleRate / 128 / 60));
    this.levelN = 0;
    this.levelRms = 0;
    this.levelPeak = 0;
    this.port.postMessage({ type: 'rate', sampleRate, ratio: this.ratio });
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    let peak = 0, sum = 0;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      sum += s * s;

      let weight = 1;
      while (weight > 1e-9) {
        const take = Math.min(weight, this.remaining);
        this.acc += s * take;
        this.accWeight += take;
        this.remaining -= take;
        weight -= take;
        if (this.remaining <= 1e-9) {
          this.out[this.outN++] = this.acc / this.accWeight;
          this.acc = 0;
          this.accWeight = 0;
          this.remaining = this.ratio;
          if (this.outN === this.out.length) {
            // Transfer the buffer rather than copying it across the thread boundary.
            this.port.postMessage({ type: 'pcm', pcm: this.out.buffer }, [this.out.buffer]);
            this.out = new Float32Array(1024);
            this.outN = 0;
          }
        }
      }
    }
    const rms = Math.sqrt(sum / ch.length);
    if (rms > this.levelRms) this.levelRms = rms;
    if (peak > this.levelPeak) this.levelPeak = peak;
    if (++this.levelN >= this.levelEvery) {
      this.port.postMessage({ type: 'level', rms: this.levelRms, peak: this.levelPeak });
      this.levelN = 0;
      this.levelRms = 0;
      this.levelPeak = 0;
    }
    return true;
  }
}

registerProcessor('mic', MicProcessor);
