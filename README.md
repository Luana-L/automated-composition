# Serial Clock

[View the project here](https://luana-l.github.io/automated-composition)

An automated composition tool built with **pitch set theory**,
running in the browser with the Web Audio API.

Given an initial pitch class sequence, the generator randomly applies
the three classical set-theoretic operations —
**Transpose (T<sub>n</sub>)**, **Invert (I)**, and **Retrograde (R)** —
to produce a chain of related variations, and plays the chain back as a
composition.

A 12-position clock face visualizes the current set as a polygon — so
the mathematics is visible as well as audible: T is a rotation, I is a
reflection, R is a direction flip.

## Controls

- **Initial sequence** — text input (e.g. `0 1 4 8` or `C Db E G#`)
  or click pitch classes directly on the clock face.
- **Presets** — classic set classes (Webern trichord, Mystic chord,
  all-interval tetrachord, Schoenberg hexachord, …).
- **Waveform** — sine, triangle, square, sawtooth, or a custom
  *rich* periodic wave. Changes the timbre of the arpeggio voice.
- **Operation weights** — three sliders bias how often each of T / I /
  R is chosen.
- **Tempo, segments, pad on/off**.
- **Play / Stop / Regenerate / Clear**.
- **Keyboard:** `space` play/stop, `r` regenerate, `c` clear.

## Goes-beyond features

- **Now-playing label + history piano-roll** — the current segment's
  operation and pitch names display above a colored piano-roll that
  paints every segment of the composition, tinted by operation, so you
  can see the whole piece scroll past.
- **Convolution reverb + stereo-spread pad** — a synthetic impulse
  response for roominess; pad voices are panned by pitch-class index
  with slight detune for thickness.
- **Selectable waveform** — five timbres for the arpeggio voice,
  including a custom additive "rich" wave.

## Files

- `auto_comp.js` — T / I / R primitives, composition generator, audio
  graph with reverb and waveform selection, clock-face + history canvas
  rendering, UI bindings.
- `index.html` — UI + a blog post reflecting on the implementation.

## Course

Lab 5 — Automated Composition. Technique: **pitch set theory** (from
scratch). Twist: simultaneous arpeggio + pad presentation so the
algebraic difference between T, I, and R is audible.
