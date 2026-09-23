// src/fx/audio.js
//
// Zero-asset sound design. Every effect is synthesised at call time with
// OscillatorNode / noise buffers through a single AudioContext, so the arcade
// ships no audio files and makes no network requests.
//
// The context is created lazily on the first user gesture (`sfx.unlock()`),
// which keeps browser autoplay policies happy. Mute state lives in RAM only.

const clamp01 = (v) => Math.max(0, Math.min(1, v))

class SynthAudio {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null
    this.master = null
    this.noiseBuffer = null
    this.muted = false
    this.volume = 0.5
    this._unlocked = false
    this._voices = 0
  }

  /**
   * Create/resume the AudioContext. Safe to call repeatedly; must be reached
   * from a user gesture at least once for audio to be audible.
   */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (!Ctor) return false
      try {
        this.ctx = new Ctor()
      } catch {
        return false
      }
      this.master = this.ctx.createGain()
      this.master.gain.value = this.muted ? 0 : this.volume
      // A gentle low-pass keeps square/saw voices from sounding harsh.
      this.shaper = this.ctx.createBiquadFilter()
      this.shaper.type = 'lowpass'
      this.shaper.frequency.value = 12000
      this.shaper.connect(this.master)
      this.master.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
    this._unlocked = true
    return true
  }

  setMuted(muted) {
    this.muted = !!muted
    if (this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.now, 0.02)
    }
    return this.muted
  }

  toggleMute() {
    return this.setMuted(!this.muted)
  }

  setVolume(v) {
    this.volume = clamp01(v)
    if (this.master && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.now, 0.02)
    }
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0
  }

  get ready() {
    return !!this.ctx && !this.muted
  }

  _bus() {
    return this.shaper || this.master
  }

  /** Shared 1s white-noise buffer (built once). */
  _noise() {
    if (!this.ctx) return null
    if (this.noiseBuffer) return this.noiseBuffer
    const rate = this.ctx.sampleRate
    const buf = this.ctx.createBuffer(1, rate, rate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuffer = buf
    return buf
  }

  /**
   * Core tone voice with an ADSR-ish envelope and optional pitch glide.
   * @param {object} o
   * @param {number} o.freq Start frequency (Hz).
   * @param {number} [o.to] Glide target frequency.
   * @param {number} [o.dur] Seconds.
   * @param {OscillatorType} [o.type]
   * @param {number} [o.gain] Peak gain 0..1.
   * @param {number} [o.attack] Seconds.
   * @param {number} [o.delay] Start offset in seconds.
   * @param {number} [o.detune] Cents.
   */
  tone({
    freq = 440,
    to = null,
    dur = 0.12,
    type = 'square',
    gain = 0.18,
    attack = 0.004,
    delay = 0,
    detune = 0,
    pan = 0,
  } = {}) {
    if (!this.ready || this._voices > 24) return
    const ctx = this.ctx
    const t0 = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    const amp = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(Math.max(20, freq), t0)
    if (detune) osc.detune.setValueAtTime(detune, t0)
    if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur)

    amp.gain.setValueAtTime(0.0001, t0)
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack)
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

    let node = amp
    if (pan && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner()
      panner.pan.value = Math.max(-1, Math.min(1, pan))
      amp.connect(panner)
      node = panner
    }
    osc.connect(amp)
    node.connect(this._bus())

    this._voices++
    osc.onended = () => { this._voices-- }
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
  }

  /**
   * Filtered noise burst — impacts, explosions, crunches, dice rattles.
   */
  noise({
    dur = 0.18,
    gain = 0.2,
    type = 'lowpass',
    freq = 1400,
    freqTo = null,
    q = 1,
    delay = 0,
    playbackRate = 1,
  } = {}) {
    if (!this.ready || this._voices > 24) return
    const ctx = this.ctx
    const buf = this._noise()
    if (!buf) return
    const t0 = ctx.currentTime + delay
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = playbackRate
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.setValueAtTime(freq, t0)
    filter.Q.value = q
    if (freqTo) filter.frequency.exponentialRampToValueAtTime(Math.max(40, freqTo), t0 + dur)
    const amp = ctx.createGain()
    amp.gain.setValueAtTime(Math.max(0.0002, gain), t0)
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

    src.connect(filter)
    filter.connect(amp)
    amp.connect(this._bus())

    this._voices++
    src.onended = () => { this._voices-- }
    src.start(t0)
    src.stop(t0 + dur + 0.02)
  }

  // -- UI -------------------------------------------------------------------

  /** Soft interface click. */
  ui() {
    this.tone({ freq: 880, to: 1320, dur: 0.06, type: 'triangle', gain: 0.1 })
  }

  hover() {
    this.tone({ freq: 1560, dur: 0.035, type: 'sine', gain: 0.045 })
  }

  /** Confirm / menu accept. */
  confirm() {
    this.tone({ freq: 660, to: 990, dur: 0.1, type: 'square', gain: 0.12 })
    this.tone({ freq: 990, to: 1480, dur: 0.12, type: 'triangle', gain: 0.09, delay: 0.06 })
  }

  deny() {
    this.tone({ freq: 220, to: 120, dur: 0.18, type: 'sawtooth', gain: 0.14 })
  }

  /** Match start fanfare (three rising blips). */
  matchStart() {
    this.tone({ freq: 523, dur: 0.1, type: 'square', gain: 0.12 })
    this.tone({ freq: 659, dur: 0.1, type: 'square', gain: 0.12, delay: 0.1 })
    this.tone({ freq: 988, dur: 0.22, type: 'triangle', gain: 0.14, delay: 0.2 })
  }

  /** Countdown pip. */
  tick(high = false) {
    this.tone({ freq: high ? 1200 : 760, dur: 0.05, type: 'square', gain: 0.1 })
  }

  // -- Combat ---------------------------------------------------------------

  shot() {
    this.tone({ freq: 720, to: 180, dur: 0.1, type: 'sawtooth', gain: 0.14 })
    this.noise({ dur: 0.08, gain: 0.16, freq: 2600, freqTo: 600 })
  }

  ricochet() {
    this.tone({ freq: 2400, to: 1500, dur: 0.06, type: 'square', gain: 0.07 })
    this.noise({ dur: 0.05, gain: 0.08, type: 'bandpass', freq: 3200, q: 6 })
  }

  hit() {
    this.noise({ dur: 0.12, gain: 0.2, freq: 1800, freqTo: 300 })
    this.tone({ freq: 160, to: 70, dur: 0.14, type: 'square', gain: 0.14 })
  }

  boom() {
    this.noise({ dur: 0.5, gain: 0.3, freq: 900, freqTo: 70, playbackRate: 0.7 })
    this.tone({ freq: 90, to: 32, dur: 0.46, type: 'sine', gain: 0.24 })
    this.tone({ freq: 220, to: 60, dur: 0.24, type: 'sawtooth', gain: 0.1, delay: 0.01 })
  }

  /** Destructible cover shattering. */
  crunch() {
    this.noise({ dur: 0.22, gain: 0.22, type: 'bandpass', freq: 1500, freqTo: 420, q: 1.6 })
    this.tone({ freq: 300, to: 110, dur: 0.16, type: 'square', gain: 0.09 })
  }

  // -- Score / pickups ------------------------------------------------------

  /** Pickup with an optional combo step that raises the pitch. */
  pickup(step = 0) {
    const base = 620 * Math.pow(1.0595, Math.min(step, 14) * 2)
    this.tone({ freq: base, to: base * 1.5, dur: 0.09, type: 'square', gain: 0.11 })
    this.tone({ freq: base * 2, dur: 0.06, type: 'sine', gain: 0.05, delay: 0.04 })
  }

  combo(multiplier = 2) {
    const n = Math.min(multiplier, 8)
    for (let i = 0; i < 3; i++) {
      this.tone({ freq: 700 + i * 220 + n * 40, dur: 0.06, type: 'triangle', gain: 0.08, delay: i * 0.045 })
    }
  }

  correct() {
    this.tone({ freq: 784, dur: 0.1, type: 'triangle', gain: 0.12 })
    this.tone({ freq: 1175, dur: 0.16, type: 'triangle', gain: 0.1, delay: 0.08 })
  }

  wrong() {
    this.tone({ freq: 300, to: 180, dur: 0.16, type: 'square', gain: 0.1 })
    this.noise({ dur: 0.1, gain: 0.08, freq: 700 })
  }

  /** Dice tumbling against the table. */
  diceRoll() {
    for (let i = 0; i < 5; i++) {
      this.noise({
        dur: 0.05,
        gain: 0.1,
        type: 'bandpass',
        freq: 1200 + Math.random() * 2200,
        q: 4,
        delay: i * 0.055 + Math.random() * 0.02,
      })
    }
  }

  /** Dice settling — single sharp knock. */
  diceLand() {
    this.noise({ dur: 0.09, gain: 0.18, type: 'bandpass', freq: 900, q: 2.2 })
    this.tone({ freq: 240, to: 120, dur: 0.1, type: 'square', gain: 0.08 })
  }

  /** Pen stroke tick for drawing games (very quiet, called sparsely). */
  stroke() {
    this.noise({ dur: 0.03, gain: 0.03, type: 'highpass', freq: 5200 })
  }

  typeKey() {
    this.tone({ freq: 1400 + Math.random() * 400, dur: 0.025, type: 'square', gain: 0.035 })
  }

  death() {
    this.tone({ freq: 440, to: 60, dur: 0.6, type: 'sawtooth', gain: 0.18 })
    this.noise({ dur: 0.4, gain: 0.14, freq: 1200, freqTo: 100 })
  }

  win() {
    const notes = [523, 659, 784, 1047]
    notes.forEach((f, i) => {
      this.tone({ freq: f, dur: 0.16, type: 'triangle', gain: 0.13, delay: i * 0.11 })
      this.tone({ freq: f * 2, dur: 0.1, type: 'sine', gain: 0.05, delay: i * 0.11 })
    })
  }

  lose() {
    const notes = [392, 330, 262, 196]
    notes.forEach((f, i) => {
      this.tone({ freq: f, dur: 0.2, type: 'square', gain: 0.11, delay: i * 0.14 })
    })
  }

  /** Round transition whoosh. */
  swipe(up = true) {
    this.noise({
      dur: 0.24,
      gain: 0.1,
      type: 'bandpass',
      freq: up ? 400 : 3000,
      freqTo: up ? 3200 : 400,
      q: 1.2,
    })
  }

  /** Release audio resources (engine teardown). Context is reused if reopened. */
  panic() {
    this._voices = 0
  }
}

/** Shared singleton — every game imports this same instance. */
export const sfx = new SynthAudio()
export default sfx
