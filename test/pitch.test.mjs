// Accuracy and behaviour checks with synthetic plucked strings. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectPitch } from '../js/pitch.js';
import { STRINGS, createTuner, cents, nearestString, findString } from '../js/tuner.js';

const ACCURACY_CENTS = 2;

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
    return () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
}

// Decaying harmonic series plus white noise; `inharmonicity` stretches upper partials like real steel strings.
function pluck(freq, {
    sampleRate = 48000,
    length = 4096,
    harmonics = [1, 0.6, 0.4, 0.25, 0.15, 0.1],
    amplitude = 0.1,
    noise = 0,
    inharmonicity = 0,
    seed = 1,
} = {}) {
    const rand = rng(seed);
    const phases = harmonics.map(() => rand() * 2 * Math.PI);
    const out = new Float32Array(length);

    for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        let v = 0;
        harmonics.forEach((a, k) => {
            const partial = k + 1;
            const f = freq * partial * Math.sqrt(1 + inharmonicity * partial * partial);
            v += a * Math.exp(-1.5 * partial * t) * Math.sin(2 * Math.PI * f * t + phases[k]);
        });
        out[i] = amplitude * v + noise * (rand() * 2 - 1);
    }
    return out;
}

function errorCents(freq, options) {
    const { freq: detected } = detectPitch(pluck(freq, options), options?.sampleRate ?? 48000);
    assert.notEqual(detected, null, `no pitch for ${freq.toFixed(2)} Hz`);
    return cents(detected, freq);
}

test('standard tuning frequencies follow A4 = 440 Hz', () => {
    const expected = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63];
    STRINGS.forEach((s, i) => assert.ok(Math.abs(s.freq - expected[i]) < 0.01, `${s.note}${s.octave}`));
});

test(`detectPitch stays within ±${ACCURACY_CENTS} cents on every string, detuned or not`, () => {
    const cases = [
        { amplitude: 0.02 },
        { amplitude: 0.3, noise: 0.01 },
        { amplitude: 0.1, inharmonicity: 1e-4 },
    ];

    for (const sampleRate of [44100, 48000]) {
        for (const options of cases) {
            for (const s of STRINGS) {
                for (const offset of [-30, -10, 0, 10, 30]) {
                    for (let seed = 1; seed <= 4; seed++) {
                        const freq = s.freq * 2 ** (offset / 1200);
                        const err = errorCents(freq, { ...options, sampleRate, seed });
                        assert.ok(
                            Math.abs(err) <= ACCURACY_CENTS,
                            `${s.note}${s.octave} ${offset}¢ @${sampleRate} ${JSON.stringify(options)}: ${err.toFixed(2)}¢`,
                        );
                    }
                }
            }
        }
    }
});

test('detectPitch does not jump an octave when the low E fundamental is weak', () => {
    const err = errorCents(STRINGS[0].freq, { harmonics: [0.15, 1, 0.7, 0.4, 0.2] });
    assert.ok(Math.abs(err) <= ACCURACY_CENTS, `${err.toFixed(2)}¢`);
});

test('detectPitch rejects silence and broadband noise', () => {
    assert.equal(detectPitch(new Float32Array(4096), 48000).freq, null);

    const rand = rng(7);
    const noise = Float32Array.from({ length: 4096 }, () => 0.05 * (rand() * 2 - 1));
    assert.equal(detectPitch(noise, 48000).freq, null);
});

// Feeds a steady reading every 40 ms, like the app does, starting with an onset at `start`.
function feed(tuner, freq, { start = 0, count = 10, rms = 0.05 } = {}) {
    let state;
    for (let i = 0; i < count; i++) state = tuner.update({ freq, rms }, start + i * 40);
    return state;
}

test('nearestString picks the closest string and resists flickering at the midpoint', () => {
    assert.equal(nearestString(112).number, 5);
    assert.equal(nearestString(320).number, 1);

    // ~5 cents past the A2/D3 midpoint: still A2 while it is the current string.
    const justPastMidpoint = Math.sqrt(110 * 146.83) * 2 ** (5 / 1200);
    assert.equal(nearestString(justPastMidpoint).number, 4);
    assert.equal(nearestString(justPastMidpoint, findString(5)).number, 5);
});

test('tuner reports string, offset and direction after the attack', () => {
    const tuner = createTuner();
    const flatA = STRINGS[1].freq * 2 ** (-20 / 1200);

    assert.equal(tuner.update({ freq: flatA, rms: 0.05 }, 0).active, false, 'attack is ignored');

    const state = feed(tuner, flatA);
    assert.equal(state.active, true);
    assert.equal(state.string.number, 5);
    assert.ok(Math.abs(state.cents + 20) < 0.01);
    assert.equal(state.direction, 'tighten');
    assert.equal(state.inTune, false);
});

test('in-tune judgement has hysteresis', () => {
    const tuner = createTuner();
    const e2 = STRINGS[0].freq;
    const at = (c) => e2 * 2 ** (c / 1200);

    assert.equal(feed(tuner, at(2)).inTune, true);
    assert.equal(feed(tuner, at(5), { start: 400 }).inTune, true, 'stays in tune inside the exit band');
    assert.equal(feed(tuner, at(8), { start: 800 }).inTune, false);
    assert.equal(feed(tuner, at(5), { start: 1200 }).inTune, false, 'must come back inside the enter band');
});

test('a single outlier is ignored but a confirmed jump is followed', () => {
    const tuner = createTuner();
    const a2 = STRINGS[1].freq;
    feed(tuner, a2);

    let state = tuner.update({ freq: a2 * 2, rms: 0.05 }, 400);
    assert.equal(state.string.number, 5, 'one octave spike does not move the display');

    const d3 = STRINGS[2].freq;
    tuner.update({ freq: d3, rms: 0.05 }, 440);
    state = tuner.update({ freq: d3, rms: 0.05 }, 480);
    assert.equal(state.string.number, 4);
});

test('a locked string warns about tuning an octave too high', () => {
    const tuner = createTuner();
    tuner.lock(6);

    const state = feed(tuner, STRINGS[0].freq * 2);
    assert.equal(state.string.number, 6);
    assert.equal(state.warning, 'octave-high');
    assert.equal(state.direction, 'loosen');

    assert.equal(tuner.lock(null).locked, null);
});

test('display goes stale, then clears, after the string stops ringing', () => {
    const tuner = createTuner();
    feed(tuner, STRINGS[3].freq);

    assert.equal(tuner.update({ freq: null, rms: 0.001 }, 400 + 360).stale, false);
    assert.equal(tuner.update({ freq: null, rms: 0.001 }, 400 + 500).stale, true);
    assert.equal(tuner.update({ freq: null, rms: 0.001 }, 400 + 3000).active, false);
});
