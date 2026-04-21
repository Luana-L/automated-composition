// auto_comp.js — Serial Clock
// Automated composition with pitch set theory.
//
// Given an initial pitch class sequence (assumed to be in normal form),
// the generator randomly applies Transpose / Inversion / Retrograde and
// plays the resulting chain as a composition.
//
// Twist: "Harmonic + Melodic Simultaneity" — each segment sounds as both
// an arpeggio (the ordered sequence) and a sustained pad (the unordered
// set). This makes the algebra of each operation audible:
//   T  shifts both voices in parallel (set rotates on the clock)
//   I  reflects both voices (set mirrors across the 0/6 axis)
//   R  changes the arpeggio order but leaves the pad untouched — because
//      retrograde is a reordering, not a set operation.

// ============ CONSTANTS ============

var NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
var NOTE_NAMES_FLAT = { Db: 1, Eb: 3, Fb: 4, Gb: 6, Ab: 8, Bb: 10, Cb: 11 };

var PRESETS = {
    'Webern trichord  (0,1,4)':            [0, 1, 4],
    'Augmented triad  (0,4,8)':            [0, 4, 8],
    'Diminished 7th   (0,3,6,9)':          [0, 3, 6, 9],
    'All-interval tet (0,1,4,6)':          [0, 1, 4, 6],
    '4-19 set class   (0,1,4,8)':          [0, 1, 4, 8],
    'Schoenberg hex   (0,1,3,4,7,8)':      [0, 1, 3, 4, 7, 8],
    'Mystic chord     (0,1,3,5,6,8,10)':   [0, 1, 3, 5, 6, 8, 10],
    'BACH motif       (B,A,C,H = 11,9,0,11→ Bb,A,C,B)': [10, 9, 0, 11]
};

// ============ PARSING ============

function parsePitchSeq(text) {
    var tokens = text.replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (/^\d+$/.test(t)) {
            var n = parseInt(t, 10);
            if (n < 0 || n > 11) return null;
            out.push(n);
        } else {
            var name = t.charAt(0).toUpperCase() + t.slice(1);
            var idx = NOTE_NAMES.indexOf(name);
            if (idx >= 0) { out.push(idx); continue; }
            if (NOTE_NAMES_FLAT[name] !== undefined) { out.push(NOTE_NAMES_FLAT[name]); continue; }
            return null;
        }
    }
    return out.length > 0 ? out : null;
}

function pcToName(pc) {
    return NOTE_NAMES[((pc % 12) + 12) % 12];
}

// ============ PITCH SET THEORY — the three required operations ============

function transpose(seq, n) {
    var m = ((n % 12) + 12) % 12;
    return seq.map(function (pc) { return (pc + m) % 12; });
}

// I_0: reflect around pitch class 0  (0↔0, 1↔11, 2↔10, 3↔9, 4↔8, 5↔7, 6↔6).
// Any I_n is expressible as T_n ∘ I_0, so the three primitives cover the full
// group of row-forms when composed.
function invert(seq) {
    return seq.map(function (pc) { return (12 - pc) % 12; });
}

function retrograde(seq) {
    return seq.slice().reverse();
}

// ============ COMPOSITION GENERATOR ============

function chooseOp(probs) {
    var total = probs.T + probs.I + probs.R;
    if (total <= 0) return 'T';
    var r = Math.random() * total;
    if (r < probs.T) return 'T';
    if (r < probs.T + probs.I) return 'I';
    return 'R';
}

function generateComposition(initialSeq, numSegments, probs) {
    var segments = [{ seq: initialSeq.slice(), op: 'P', label: 'P' }];
    var current = initialSeq.slice();
    for (var i = 0; i < numSegments; i++) {
        var op = chooseOp(probs);
        var label;
        if (op === 'T') {
            var n = 1 + Math.floor(Math.random() * 11); // 1..11 (skip identity)
            current = transpose(current, n);
            label = 'T' + n;
        } else if (op === 'I') {
            current = invert(current);
            label = 'I';
        } else {
            current = retrograde(current);
            label = 'R';
        }
        segments.push({ seq: current.slice(), op: op, label: label });
    }
    return segments;
}

// ============ STATE ============

var audioCtx = null;
var masterGain = null;
var dryGain = null;
var wetGain = null;
var reverbNode = null;
var isPlaying = false;
var playbackTimer = null;

var settings = {
    initialSeq: [0, 1, 4, 8],
    numSegments: 32,
    bpm: 180,
    rootOctave: 4,
    probT: 4,
    probI: 3,
    probR: 3,
    padEnabled: true,
    waveform: 'triangle'
};

// Waveform catalog. Five options: four standard OscillatorNode types plus
// a custom "rich" PeriodicWave (saw-ish spectrum with rolled-off upper
// harmonics) that gives the arp a more reedy, complex voice.
var WAVEFORM_OPTIONS = ['sine', 'triangle', 'square', 'sawtooth', 'rich'];
var richWave = null;

function getRichWave(ctx) {
    if (richWave) return richWave;
    var real = new Float32Array([0, 1, 0.55, 0.32, 0.18, 0.10, 0.06, 0.03]);
    var imag = new Float32Array(real.length);
    richWave = ctx.createPeriodicWave(real, imag);
    return richWave;
}

function applyWaveform(osc, name) {
    if (name === 'rich') {
        osc.setPeriodicWave(getRichWave(osc.context));
    } else {
        osc.type = name;
    }
}

var composition = [];
var currentSegIdx = 0;
var currentNoteIdx = 0;
var activePC = null;
var currentPadNodes = null;
var lastArpMidi = null;

var clockCanvas = null;
var clockCtx = null;
var historyCanvas = null;
var historyCtx = null;

// ============ AUDIO ============

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// Build a synthetic impulse response (exponentially decaying stereo noise)
// for a ConvolverNode. Gives the piece a roomy, spacious feel — serial music
// rewards reverb because pitches from adjacent segments get to overlap and
// reveal the set's harmonic color.
function buildImpulseResponse(ctx, seconds, decay) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
        var data = ir.getChannelData(ch);
        for (var i = 0; i < len; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
    }
    return ir;
}

// Octave-wrap the arpeggio so consecutive notes are close — keeps the line legato.
function pcToArpMidi(pc) {
    var base = 12 * (settings.rootOctave + 1) + pc;
    if (lastArpMidi === null) { lastArpMidi = base; return base; }
    var best = base;
    var bestDist = Math.abs(base - lastArpMidi);
    for (var oct = -1; oct <= 1; oct++) {
        var cand = base + oct * 12;
        var d = Math.abs(cand - lastArpMidi);
        if (d < bestDist) { bestDist = d; best = cand; }
    }
    lastArpMidi = best;
    return best;
}

function pcToPadMidi(pc) {
    return 12 * settings.rootOctave + pc;
}

function playArpNote(pc, startTime, duration) {
    if (!audioCtx) return;
    var osc = audioCtx.createOscillator();
    var g = audioCtx.createGain();
    applyWaveform(osc, settings.waveform);
    osc.frequency.value = midiToFreq(pcToArpMidi(pc));
    // Bright waveforms ring louder — compensate so they don't dominate the pad.
    var peak = (settings.waveform === 'sawtooth' || settings.waveform === 'square') ? 0.14
             : (settings.waveform === 'rich') ? 0.17
             : 0.22;
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(peak, startTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
}

// Pad voices are spread across the stereo field by pitch class index so the
// sustained chord sounds like it actually occupies space instead of being
// glued to the center. Slight per-voice detune thickens the result.
function makePad(seq, startTime) {
    if (!audioCtx) return null;
    var nodes = [];
    var uniq = Array.from(new Set(seq));
    uniq.forEach(function (pc, i) {
        var osc = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        var panner = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
        osc.type = 'sine';
        osc.frequency.value = midiToFreq(pcToPadMidi(pc));
        osc.detune.value = ((i % 2 === 0) ? -4 : 4); // gentle chorus
        g.gain.setValueAtTime(0, startTime);
        g.gain.linearRampToValueAtTime(0.05, startTime + 0.4);
        osc.connect(g);
        if (panner) {
            var spread = uniq.length > 1 ? (i / (uniq.length - 1)) * 2 - 1 : 0;
            panner.pan.value = spread * 0.6;
            g.connect(panner);
            panner.connect(masterGain);
        } else {
            g.connect(masterGain);
        }
        osc.start(startTime);
        nodes.push({ osc: osc, gain: g });
    });
    return nodes;
}

function stopPad(nodes, stopTime) {
    if (!nodes) return;
    nodes.forEach(function (n) {
        try {
            n.gain.gain.cancelScheduledValues(stopTime);
            n.gain.gain.setValueAtTime(n.gain.gain.value, stopTime);
            n.gain.gain.exponentialRampToValueAtTime(0.0001, stopTime + 0.35);
            n.osc.stop(stopTime + 0.45);
        } catch (e) { /* node may have already stopped */ }
    });
}

// ============ PLAYBACK ============

function refreshPadForCurrentSegment() {
    if (!settings.padEnabled || !audioCtx) return;
    var now = audioCtx.currentTime;
    if (currentPadNodes) stopPad(currentPadNodes, now);
    var seg = composition[currentSegIdx];
    if (seg) currentPadNodes = makePad(seg.seq, now);
}

function playbackStep() {
    if (!isPlaying || !audioCtx) return;
    var seg = composition[currentSegIdx];
    if (!seg) { stop(); return; }
    var pc = seg.seq[currentNoteIdx];
    var dur = 60 / settings.bpm;
    playArpNote(pc, audioCtx.currentTime, dur * 1.1);
    activePC = pc;
    drawClock();
    drawHistory();

    currentNoteIdx++;
    if (currentNoteIdx >= seg.seq.length) {
        currentNoteIdx = 0;
        currentSegIdx++;
        if (currentSegIdx >= composition.length) { stop(); return; }
        lastArpMidi = null;

        // Only swap the pad when the set actually changed — retrograde leaves
        // the (unordered) pitch class set untouched, so we let the pad ring.
        var prev = composition[currentSegIdx - 1];
        var cur = composition[currentSegIdx];
        if (cur.op !== 'R' && !sameSet(prev.seq, cur.seq)) refreshPadForCurrentSegment();

        updateCurrentLabel();
        drawHistory();
    }
}

function sameSet(a, b) {
    var sa = Array.from(new Set(a)).sort(function (x, y) { return x - y; });
    var sb = Array.from(new Set(b)).sort(function (x, y) { return x - y; });
    if (sa.length !== sb.length) return false;
    for (var i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
}

function start() {
    if (isPlaying) return;
    if (!settings.initialSeq || settings.initialSeq.length === 0) return;
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.55;
        dryGain = audioCtx.createGain();
        dryGain.gain.value = 0.85;
        wetGain = audioCtx.createGain();
        wetGain.gain.value = 0.35;
        reverbNode = audioCtx.createConvolver();
        reverbNode.buffer = buildImpulseResponse(audioCtx, 2.4, 2.2);
        masterGain.connect(dryGain);
        masterGain.connect(reverbNode);
        reverbNode.connect(wetGain);
        dryGain.connect(audioCtx.destination);
        wetGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();

    composition = generateComposition(
        settings.initialSeq,
        settings.numSegments,
        { T: settings.probT, I: settings.probI, R: settings.probR }
    );
    currentSegIdx = 0;
    currentNoteIdx = 0;
    lastArpMidi = null;
    activePC = null;
    isPlaying = true;

    refreshPadForCurrentSegment();
    updateCurrentLabel();
    drawHistory();

    document.getElementById('btn-play').disabled = true;
    document.getElementById('btn-stop').disabled = false;

    playbackStep();
    playbackTimer = setInterval(playbackStep, 60000 / settings.bpm);
}

function stop() {
    isPlaying = false;
    if (playbackTimer) { clearInterval(playbackTimer); playbackTimer = null; }
    if (currentPadNodes && audioCtx) { stopPad(currentPadNodes, audioCtx.currentTime); currentPadNodes = null; }
    activePC = null;
    drawClock();
    drawHistory();
    document.getElementById('btn-play').disabled = false;
    document.getElementById('btn-stop').disabled = true;
}

// ============ CANVAS ============

function resizeClock() {
    if (!clockCanvas) return;
    var dpr = window.devicePixelRatio || 1;
    var rect = clockCanvas.getBoundingClientRect();
    clockCanvas.width = rect.width * dpr;
    clockCanvas.height = rect.height * dpr;
    clockCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawClock() {
    if (!clockCtx) return;
    var rect = clockCanvas.getBoundingClientRect();
    var W = rect.width, H = rect.height;
    var cx = W / 2, cy = H / 2;
    var radius = Math.min(W, H) * 0.36;

    clockCtx.fillStyle = '#0e0e14';
    clockCtx.fillRect(0, 0, W, H);

    clockCtx.strokeStyle = '#3a3a48';
    clockCtx.lineWidth = 1;
    clockCtx.beginPath();
    clockCtx.arc(cx, cy, radius, 0, Math.PI * 2);
    clockCtx.stroke();

    // Inversion axis hint (the 0↔0, 6↔6 line)
    clockCtx.strokeStyle = 'rgba(127, 209, 199, 0.12)';
    clockCtx.setLineDash([2, 4]);
    clockCtx.beginPath();
    var top = { x: cx, y: cy - radius };
    var bot = { x: cx, y: cy + radius };
    clockCtx.moveTo(top.x, top.y); clockCtx.lineTo(bot.x, bot.y);
    clockCtx.stroke();
    clockCtx.setLineDash([]);

    var displaySeq = (isPlaying && composition[currentSegIdx])
        ? composition[currentSegIdx].seq
        : settings.initialSeq;
    var uniq = Array.from(new Set(displaySeq));

    function pcToXY(pc) {
        var a = (pc / 12) * 2 * Math.PI - Math.PI / 2;
        return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a), angle: a };
    }

    // Draw polygon connecting sequence in order (shape of the set)
    if (displaySeq.length >= 2) {
        clockCtx.strokeStyle = 'rgba(127, 209, 199, 0.55)';
        clockCtx.lineWidth = 1.5;
        clockCtx.beginPath();
        for (var i = 0; i < displaySeq.length; i++) {
            var p = pcToXY(displaySeq[i]);
            if (i === 0) clockCtx.moveTo(p.x, p.y);
            else clockCtx.lineTo(p.x, p.y);
        }
        clockCtx.stroke();
    }

    // 12 PC positions
    for (var pc = 0; pc < 12; pc++) {
        var p = pcToXY(pc);
        var isActive = uniq.indexOf(pc) >= 0;
        var isSounding = activePC === pc;

        var r = isSounding ? 11 : (isActive ? 8 : 4);
        clockCtx.fillStyle = isSounding ? '#ff8a4d' : (isActive ? '#7fd1c7' : '#3a3a48');
        clockCtx.beginPath();
        clockCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
        clockCtx.fill();

        var labelR = radius + 22;
        var lx = cx + labelR * Math.cos(p.angle);
        var ly = cy + labelR * Math.sin(p.angle);
        clockCtx.fillStyle = isActive ? '#d8d8d4' : '#707078';
        clockCtx.font = '12px "SF Mono", Menlo, monospace';
        clockCtx.textAlign = 'center';
        clockCtx.textBaseline = 'middle';
        clockCtx.fillText(NOTE_NAMES[pc], lx, ly);
    }

    // Center: current op label
    var centerLabel = (isPlaying && composition[currentSegIdx]) ? composition[currentSegIdx].label : 'P';
    clockCtx.fillStyle = '#d8d8d4';
    clockCtx.font = 'bold 22px Georgia, serif';
    clockCtx.textAlign = 'center';
    clockCtx.textBaseline = 'middle';
    clockCtx.fillText(centerLabel, cx, cy);
}

function handleClockClick(e) {
    if (isPlaying) return; // only let the user edit while stopped
    var rect = clockCanvas.getBoundingClientRect();
    var cx = rect.width / 2, cy = rect.height / 2;
    var x = e.clientX - rect.left - cx;
    var y = e.clientY - rect.top - cy;
    var radius = Math.min(rect.width, rect.height) * 0.36;
    var bestPC = -1, bestD = Infinity;
    for (var pc = 0; pc < 12; pc++) {
        var a = (pc / 12) * 2 * Math.PI - Math.PI / 2;
        var px = radius * Math.cos(a);
        var py = radius * Math.sin(a);
        var d = Math.hypot(x - px, y - py);
        if (d < bestD) { bestD = d; bestPC = pc; }
    }
    if (bestD < 24) {
        var idx = settings.initialSeq.indexOf(bestPC);
        if (idx >= 0) settings.initialSeq.splice(idx, 1);
        else settings.initialSeq.push(bestPC);
        document.getElementById('seq-input').value = settings.initialSeq.join(' ');
        drawClock();
    }
}

// ============ HISTORY PIANO-ROLL ============
// Paints every segment in the composition as a vertical slice: 12 cells for
// the 12 pitch classes, filled if that PC is in the segment's set. The
// current segment glows. Lets you see the entire piece as a harmonic landscape
// scrolling past.

function resizeHistory() {
    if (!historyCanvas) return;
    var dpr = window.devicePixelRatio || 1;
    var rect = historyCanvas.getBoundingClientRect();
    historyCanvas.width = rect.width * dpr;
    historyCanvas.height = rect.height * dpr;
    historyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawHistory() {
    if (!historyCtx) return;
    var rect = historyCanvas.getBoundingClientRect();
    var W = rect.width, H = rect.height;
    historyCtx.fillStyle = '#0e0e14';
    historyCtx.fillRect(0, 0, W, H);

    if (!composition.length) return;

    var n = composition.length;
    var colW = Math.max(2, W / n);
    var labelStripH = 18;
    var pianoH = H - labelStripH;
    var rowH = pianoH / 12;

    function colorForOp(op) {
        if (op === 'P') return '#d8d8d4';
        if (op === 'T') return '#7fd1c7';
        if (op === 'I') return '#e0a078';
        return '#a68bc9';
    }

    // Only draw labels when columns are wide enough to read; otherwise cycle
    // through every Kth so the roll stays legible without overlap.
    var labelStep = 1;
    if (colW < 18) labelStep = Math.ceil(18 / colW);

    for (var s = 0; s < n; s++) {
        var seg = composition[s];
        var x = s * colW;
        var isCurrent = isPlaying && s === currentSegIdx;

        if (isCurrent) {
            historyCtx.fillStyle = 'rgba(255, 138, 77, 0.18)';
            historyCtx.fillRect(x, 0, colW, H);
        }

        var active = new Set(seg.seq);
        for (var pc = 0; pc < 12; pc++) {
            if (!active.has(pc)) continue;
            var y = (11 - pc) * rowH;
            historyCtx.fillStyle = isCurrent ? '#ff8a4d' : colorForOp(seg.op);
            historyCtx.fillRect(x + 0.5, y + 0.5, Math.max(1, colW - 1), Math.max(1, rowH - 1));
        }

        if (s % labelStep === 0 || isCurrent) {
            historyCtx.fillStyle = isCurrent ? '#ff8a4d' : colorForOp(seg.op);
            historyCtx.font = (isCurrent ? 'bold ' : '') + '10px "SF Mono", Menlo, monospace';
            historyCtx.textAlign = 'center';
            historyCtx.textBaseline = 'middle';
            historyCtx.fillText(seg.label, x + colW / 2, pianoH + labelStripH / 2);
        }
    }

    historyCtx.strokeStyle = 'rgba(255,255,255,0.06)';
    historyCtx.beginPath();
    historyCtx.moveTo(0, pianoH + 0.5);
    historyCtx.lineTo(W, pianoH + 0.5);
    historyCtx.stroke();
}

// ============ UI ============

function updateCurrentLabel() {
    var el = document.getElementById('current-label');
    if (!el) return;
    var seg = composition[currentSegIdx];
    if (!seg) { el.textContent = '—'; return; }
    el.innerHTML = '<strong>' + seg.label + '</strong> &rarr; ['
        + seg.seq.map(pcToName).join(' ') + ']';
}

function applyInputSequence() {
    var text = document.getElementById('seq-input').value;
    var parsed = parsePitchSeq(text);
    if (parsed && parsed.length > 0) {
        settings.initialSeq = parsed;
        drawClock();
    }
}

function initUI() {
    clockCanvas = document.getElementById('clock-canvas');
    if (!clockCanvas) return;
    clockCtx = clockCanvas.getContext('2d');
    resizeClock();
    clockCanvas.addEventListener('click', handleClockClick);

    historyCanvas = document.getElementById('history-canvas');
    if (historyCanvas) {
        historyCtx = historyCanvas.getContext('2d');
        resizeHistory();
    }

    window.addEventListener('resize', function () {
        resizeClock(); drawClock();
        resizeHistory(); drawHistory();
    });

    var presetSelect = document.getElementById('preset-select');
    Object.keys(PRESETS).forEach(function (name) {
        var opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        presetSelect.appendChild(opt);
    });
    presetSelect.addEventListener('change', function () {
        if (!presetSelect.value) return;
        settings.initialSeq = PRESETS[presetSelect.value].slice();
        document.getElementById('seq-input').value = settings.initialSeq.join(' ');
        drawClock();
        presetSelect.value = '';
    });

    var seqInput = document.getElementById('seq-input');
    seqInput.value = settings.initialSeq.join(' ');
    seqInput.addEventListener('change', applyInputSequence);
    seqInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); applyInputSequence(); }
    });

    var bpm = document.getElementById('bpm-slider');
    bpm.addEventListener('input', function () {
        settings.bpm = parseInt(bpm.value, 10);
        document.getElementById('bpm-display').textContent = settings.bpm;
        if (isPlaying && playbackTimer) {
            clearInterval(playbackTimer);
            playbackTimer = setInterval(playbackStep, 60000 / settings.bpm);
        }
    });

    var nseg = document.getElementById('nseg-slider');
    nseg.addEventListener('input', function () {
        settings.numSegments = parseInt(nseg.value, 10);
        document.getElementById('nseg-display').textContent = settings.numSegments;
    });

    ['T', 'I', 'R'].forEach(function (op) {
        var s = document.getElementById('prob-' + op);
        s.addEventListener('input', function () {
            settings['prob' + op] = parseInt(s.value, 10);
            updateWeightDisplays();
        });
    });

    var pad = document.getElementById('pad-toggle');
    pad.addEventListener('change', function () {
        settings.padEnabled = pad.checked;
        if (!pad.checked && currentPadNodes && audioCtx) {
            stopPad(currentPadNodes, audioCtx.currentTime);
            currentPadNodes = null;
        } else if (pad.checked && isPlaying) {
            refreshPadForCurrentSegment();
        }
    });

    var waveformSelect = document.getElementById('waveform-select');
    if (waveformSelect) {
        WAVEFORM_OPTIONS.forEach(function (w) {
            var opt = document.createElement('option');
            opt.value = w;
            opt.textContent = w.charAt(0).toUpperCase() + w.slice(1);
            if (w === settings.waveform) opt.selected = true;
            waveformSelect.appendChild(opt);
        });
        waveformSelect.addEventListener('change', function () {
            settings.waveform = waveformSelect.value;
        });
    }

    document.getElementById('btn-play').addEventListener('click', start);
    document.getElementById('btn-stop').addEventListener('click', stop);
    document.getElementById('btn-regen').addEventListener('click', function () {
        if (isPlaying) { stop(); setTimeout(start, 60); }
        else start();
    });
    document.getElementById('btn-clear').addEventListener('click', function () {
        if (isPlaying) stop();
        settings.initialSeq = [];
        seqInput.value = '';
        drawClock();
    });

    document.addEventListener('keydown', function (e) {
        var tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key === ' ') {
            e.preventDefault();
            if (isPlaying) stop(); else start();
        } else if (e.key === 'r' || e.key === 'R') {
            document.getElementById('btn-regen').click();
        } else if (e.key === 'c' || e.key === 'C') {
            document.getElementById('btn-clear').click();
        }
    });

    document.getElementById('bpm-display').textContent = settings.bpm;
    document.getElementById('nseg-display').textContent = settings.numSegments;
    updateWeightDisplays();

    drawClock();
}

// Translate the three raw weights into probability percentages and render
// both the per-slider labels and the stacked bar. Makes it obvious that the
// weights are relative: 4/4/4 and 10/10/10 give the same 33/33/33 split.
function updateWeightDisplays() {
    var t = settings.probT, i = settings.probI, r = settings.probR;
    var total = t + i + r;
    var pT = total > 0 ? (t / total) * 100 : 0;
    var pI = total > 0 ? (i / total) * 100 : 0;
    var pR = total > 0 ? (r / total) * 100 : 0;

    var fmt = function (p) { return total > 0 ? Math.round(p) + '%' : '—'; };
    document.getElementById('prob-T-display').textContent = fmt(pT);
    document.getElementById('prob-I-display').textContent = fmt(pI);
    document.getElementById('prob-R-display').textContent = fmt(pR);

    var bar = document.getElementById('weight-bar');
    if (!bar) return;
    if (total <= 0) {
        bar.innerHTML = '<div class="weight-bar-empty">all weights zero — set at least one above 0</div>';
        return;
    }
    function seg(op, pct) {
        var label = pct >= 12 ? op + ' ' + Math.round(pct) + '%' : (pct >= 6 ? Math.round(pct) + '%' : '');
        return '<div class="weight-seg weight-' + op + '" style="width:' + pct + '%">' + label + '</div>';
    }
    bar.innerHTML = seg('T', pT) + seg('I', pI) + seg('R', pR);
}

window.addEventListener('DOMContentLoaded', initUI);
