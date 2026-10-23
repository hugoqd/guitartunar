// Monophonic pitch detection based on the McLeod Pitch Method (normalized square difference function).
// Plain autocorrelation is biased toward short lags because fewer samples overlap as the lag grows,
// which reads low guitar strings several cents sharp; the NSDF normalizes that taper away.

export const MIN_FREQ = 60;
export const MAX_FREQ = 700;
export const MIN_RMS = 0.003;
export const MIN_CLARITY = 0.8;

// Take the first peak within 90% of the strongest one: the strongest is often a multiple of the period.
const KEY_MAX_RATIO = 0.9;

let scratch = new Float64Array(0);

/**
 * Estimates the fundamental frequency of a block of time-domain samples.
 * `freq` is null when the block is too quiet or not periodic enough to trust.
 * Example: detectPitch(samples, 48000) -> { freq: 110.02, clarity: 0.98, rms: 0.07 }
 */
export function detectPitch(samples, sampleRate, { minFreq = MIN_FREQ, maxFreq = MAX_FREQ } = {}) {
    const n = samples.length;
    if (scratch.length !== n) scratch = new Float64Array(n);
    const x = scratch;

    // Remove DC so a microphone offset does not inflate the correlation.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += samples[i];
    mean /= n;

    let energy = 0;
    for (let i = 0; i < n; i++) {
        x[i] = samples[i] - mean;
        energy += x[i] * x[i];
    }

    const rms = Math.sqrt(energy / n);
    if (rms < MIN_RMS) return { freq: null, clarity: 0, rms };

    const maxLag = Math.min(Math.ceil(sampleRate / minFreq), n - 2);
    const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
    const nsdf = computeNsdf(x, energy, maxLag + 1);

    const peak = pickPeriodPeak(nsdf, minLag, maxLag);
    if (peak < 0) return { freq: null, clarity: 0, rms };

    // Parabolic interpolation gives sub-sample period resolution; one sample at E2 is ~2 cents.
    const a = nsdf[peak - 1];
    const b = nsdf[peak];
    const c = nsdf[peak + 1];
    const denom = a - 2 * b + c;
    const shift = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
    const clarity = b - 0.25 * (a - c) * shift;
    const freq = sampleRate / (peak + shift);

    if (clarity < MIN_CLARITY || freq < minFreq || freq > maxFreq) {
        return { freq: null, clarity, rms };
    }
    return { freq, clarity, rms };
}

function computeNsdf(x, energy, maxLag) {
    const n = x.length;
    const nsdf = new Float64Array(maxLag + 1);

    // m(tau) = sum of x[j]^2 + x[j+tau]^2 over the overlap; updated incrementally instead of re-summed.
    let m = 2 * energy;
    for (let tau = 0; tau <= maxLag; tau++) {
        if (tau > 0) m -= x[n - tau] * x[n - tau] + x[tau - 1] * x[tau - 1];

        let r = 0;
        for (let j = 0, end = n - tau; j < end; j++) r += x[j] * x[j + tau];

        nsdf[tau] = m > 0 ? (2 * r) / m : 0;
    }
    return nsdf;
}

// Returns the lag of the chosen key maximum, or -1 when no usable peak exists.
function pickPeriodPeak(nsdf, minLag, maxLag) {
    const peaks = [];
    let tau = 1;

    // Skip the lobe around lag 0, which is trivially 1.
    while (tau <= maxLag && nsdf[tau] > 0) tau++;

    // One key maximum per positive region between zero crossings.
    let best = -1;
    for (; tau <= maxLag; tau++) {
        if (nsdf[tau] > 0) {
            if (best < 0 || nsdf[tau] > nsdf[best]) best = tau;
        } else if (best >= 0) {
            peaks.push(best);
            best = -1;
        }
    }
    // A region still rising at the search limit has no real peak inside the range.
    if (best >= 0 && nsdf[best] >= nsdf[best + 1]) peaks.push(best);

    const candidates = peaks.filter((p) => p >= minLag && p < maxLag);
    if (candidates.length === 0) return -1;

    const highest = Math.max(...candidates.map((p) => nsdf[p]));
    return candidates.find((p) => nsdf[p] >= KEY_MAX_RATIO * highest);
}
