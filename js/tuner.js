// Turns raw pitch readings into what the UI shows: which string, how many cents off, which way to turn.

import { MIN_RMS } from './pitch.js';

const A4 = 440;
const midiToFreq = (midi) => A4 * 2 ** ((midi - 69) / 12);

/** Standard tuning, from the 6th (lowest) string to the 1st. */
export const STRINGS = [
    { number: 6, note: 'E', octave: 2, midi: 40 },
    { number: 5, note: 'A', octave: 2, midi: 45 },
    { number: 4, note: 'D', octave: 3, midi: 50 },
    { number: 3, note: 'G', octave: 3, midi: 55 },
    { number: 2, note: 'B', octave: 3, midi: 59 },
    { number: 1, note: 'E', octave: 4, midi: 64 },
].map((s) => Object.freeze({ ...s, freq: midiToFreq(s.midi) }));

// Enter "in tune" tighter than we leave it, so the display does not flicker at the edge.
export const IN_TUNE_ENTER_CENTS = 3;
export const IN_TUNE_EXIT_CENTS = 6;
export const METER_RANGE_CENTS = 50;

const ATTACK_MS = 120; // a plucked string starts a few cents sharp before it settles
const ONSET_RMS_RATIO = 1.8;
const HISTORY_SIZE = 5;
const JUMP_CENTS = 80; // a reading this far from the running median needs a second one to confirm it
const CONFIRM_CENTS = 30;
const STALE_MS = 400;
const CLEAR_MS = 2500;
const SWITCH_MARGIN_CENTS = 25;
const OCTAVE_TOLERANCE_CENTS = 100;

export function cents(freq, ref) {
    return 1200 * Math.log2(freq / ref);
}

export function findString(number) {
    return STRINGS.find((s) => s.number === number) ?? null;
}

/** Closest string to `freq`; keeps `current` unless another string is clearly closer. */
export function nearestString(freq, current = null) {
    const distance = (s) => Math.abs(cents(freq, s.freq));

    let best = STRINGS[0];
    for (const s of STRINGS) {
        if (distance(s) < distance(best)) best = s;
    }

    if (current && best !== current && distance(current) - distance(best) < SWITCH_MARGIN_CENTS) {
        return current;
    }
    return best;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Stateful tuner fed with detectPitch() readings and a monotonic timestamp in ms.
 * Every call returns the state to render; `direction` is 'tighten' | 'loosen' | null and
 * `warning` is 'octave-high' | 'octave-low' | 'far' | null.
 * Example: tuner.update({ freq: 110.4, rms: 0.05 }, performance.now()).string.number -> 5
 */
export function createTuner() {
    let history = [];
    let pending = null;
    let prevRms = 0;
    let onsetAt = -Infinity;
    let lastValidAt = -Infinity;

    let lockedString = null;
    let autoString = null;
    let judgedString = null;
    let inTune = false;
    let state = idleState();

    function idleState() {
        return {
            active: false,
            stale: false,
            freq: null,
            string: null,
            cents: null,
            inTune: false,
            direction: null,
            warning: null,
            locked: lockedString?.number ?? null,
        };
    }

    function evaluate(freq) {
        if (!lockedString) autoString = nearestString(freq, autoString);
        const string = lockedString ?? autoString;
        const offset = cents(freq, string.freq);

        if (string !== judgedString) inTune = false;
        judgedString = string;
        inTune = Math.abs(offset) <= (inTune ? IN_TUNE_EXIT_CENTS : IN_TUNE_ENTER_CENTS);

        // Only a locked string can tell an octave mistake apart from simply being near another string.
        let warning = null;
        if (lockedString && Math.abs(offset - 1200) < OCTAVE_TOLERANCE_CENTS) warning = 'octave-high';
        else if (lockedString && Math.abs(offset + 1200) < OCTAVE_TOLERANCE_CENTS) warning = 'octave-low';
        else if (Math.abs(offset) > METER_RANGE_CENTS) warning = 'far';

        state = {
            active: true,
            stale: false,
            freq,
            string,
            cents: offset,
            inTune,
            direction: inTune ? null : offset < 0 ? 'tighten' : 'loosen',
            warning,
            locked: lockedString?.number ?? null,
        };
        return state;
    }

    // Keeps the last reading on screen for a moment after the string stops ringing.
    function holdOrClear(now) {
        if (!state.active) return state;

        const age = now - lastValidAt;
        if (age > CLEAR_MS) {
            history = [];
            inTune = false;
            state = idleState();
        } else if (age > STALE_MS && !state.stale) {
            state = { ...state, stale: true };
        }
        return state;
    }

    // Returns false when the reading is an unconfirmed outlier.
    function accept(freq) {
        if (history.length > 0 && Math.abs(cents(freq, median(history))) > JUMP_CENTS) {
            if (pending !== null && Math.abs(cents(freq, pending)) < CONFIRM_CENTS) {
                history = [pending, freq];
                pending = null;
                return true;
            }
            pending = freq;
            return false;
        }

        pending = null;
        history.push(freq);
        if (history.length > HISTORY_SIZE) history.shift();
        return true;
    }

    function update(reading, now) {
        const freq = reading?.freq ?? null;
        const rms = reading?.rms ?? 0;

        // A fresh pluck: drop readings of the previous note and wait out the sharp attack.
        if (rms >= MIN_RMS && rms > prevRms * ONSET_RMS_RATIO) {
            onsetAt = now;
            history = [];
            pending = null;
        }
        prevRms = rms;

        if (now - onsetAt < ATTACK_MS || freq === null || !accept(freq)) {
            return holdOrClear(now);
        }

        lastValidAt = now;
        if (history.length < 2) return holdOrClear(now);
        return evaluate(median(history));
    }

    function setLock(string) {
        lockedString = string;
        autoString = null;
        inTune = false;
        if (state.active && history.length > 0) {
            const stale = state.stale;
            evaluate(median(history));
            state.stale = stale;
        } else {
            state = { ...state, locked: lockedString?.number ?? null };
        }
        return state;
    }

    return {
        update,
        /** Restricts judgement to one string; null returns to automatic string detection. */
        lock: (number) => setLock(number === null ? null : findString(number)),
        /** Clears readings but keeps the locked string. */
        reset() {
            history = [];
            pending = null;
            prevRms = 0;
            onsetAt = -Infinity;
            lastValidAt = -Infinity;
            autoString = null;
            judgedString = null;
            inTune = false;
            state = idleState();
            return state;
        },
        get state() {
            return state;
        },
    };
}
