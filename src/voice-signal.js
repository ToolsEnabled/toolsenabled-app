// What the Home voice widget is doing, for the Home circle's voice-mode animations.
// The widget (voice-coordinator.js) writes here; the circle (home-circle-fluid.js)
// reads it on its own animation step. This module never touches media: the level
// comes from the widget's existing on-screen bars (voice-audio-visualizer.js reads
// streams the voice session already owns), and `heard` is a transcript the widget
// already shows. Nothing here is recorded, stored or sent.
export const voiceSignal = { level: 0, heard: '', heardSeq: 0 }

// Mean of the widget's bar levels (0..1) for the frame it just drew.
export function publishVoiceLevel(levels) {
  let sum = 0, count = 0
  for (const value of levels || []) { if (Number.isFinite(value)) { sum += value; count++ } }
  voiceSignal.level = count ? Math.min(1, Math.max(0, sum / count)) : 0
}

// A final transcript the widget received for the voice contact it is bound to.
export function publishVoiceHeard(text) {
  voiceSignal.heard = typeof text === 'string' ? text.slice(0, 512) : ''
  voiceSignal.heardSeq += 1
}
