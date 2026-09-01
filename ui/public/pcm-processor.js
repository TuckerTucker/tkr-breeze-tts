/**
 * AudioWorkletProcessor that plays float32 samples as they arrive.
 *
 * It lives in `public/` rather than beside `player.ts` on purpose.
 * `AudioWorklet.addModule` loads this file into a *separate global scope* with
 * its own module graph, so it must reach the browser untransformed and at a
 * stable URL. Anything under `src/` would be bundled, wrapped, and hashed —
 * and a wrapped processor never reaches `registerProcessor`.
 *
 * A ring buffer sits between the network and the audio callback because the
 * two run on different clocks: chunks arrive in bursts, and the callback wants
 * exactly 128 frames every 2.7ms at 48kHz. The buffer absorbs that jitter
 * without adding perceptible delay.
 *
 * On underrun it emits silence and *holds* rather than stopping. A click at a
 * chunk boundary is the difference between a demo that sounds fast and one
 * that sounds broken, and stopping on the first gap would end playback the
 * first time the network hesitated.
 */

const RING_CAPACITY = 24000 * 8; // eight seconds at the model's rate

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(RING_CAPACITY);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;
    this.ended = false;
    this.started = false;
    this.underruns = 0;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'samples') {
        this.enqueue(message.samples);
      } else if (message.type === 'end') {
        this.ended = true;
      } else if (message.type === 'reset') {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        this.ended = false;
        this.started = false;
      }
    };
  }

  /**
   * Copy incoming samples into the ring.
   *
   * @param {Float32Array} samples - Converted float32 samples.
   */
  enqueue(samples) {
    for (let i = 0; i < samples.length; i += 1) {
      this.ring[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % RING_CAPACITY;
      if (this.available < RING_CAPACITY) {
        this.available += 1;
      } else {
        // Overrun: the reader has fallen a full buffer behind. Drop the oldest
        // sample rather than the newest, so playback stays live.
        this.readIndex = (this.readIndex + 1) % RING_CAPACITY;
      }
    }
    if (!this.started && this.available > 0) {
      this.started = true;
      this.port.postMessage({ type: 'started' });
    }
  }

  /**
   * Fill one render quantum.
   *
   * @param {Float32Array[][]} _inputs - Unused.
   * @param {Float32Array[][]} outputs - Output channels.
   * @returns {boolean} Whether to keep the node alive.
   */
  process(_inputs, outputs) {
    const channel = outputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      if (this.available > 0) {
        channel[i] = this.ring[this.readIndex];
        this.readIndex = (this.readIndex + 1) % RING_CAPACITY;
        this.available -= 1;
      } else {
        // Hold at silence rather than emitting a click, and resume when data
        // arrives.
        channel[i] = 0;
      }
    }

    if (this.available === 0) {
      if (this.ended) {
        this.port.postMessage({ type: 'drained' });
        return false;
      }
      if (this.started) {
        this.underruns += 1;
        if (this.underruns % 32 === 1) {
          this.port.postMessage({ type: 'underrun' });
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
