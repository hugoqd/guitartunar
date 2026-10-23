// Wires the microphone, the pitch detector and the tuner state into the pedal UI.

import { detectPitch } from './pitch.js';
import { STRINGS, METER_RANGE_CENTS, createTuner } from './tuner.js';
import { createSegmentDisplay } from './segments.js';

const FFT_SIZE = 4096; // ~85 ms at 48 kHz: holds about 7 periods of the low E string
const ANALYSIS_INTERVAL_MS = 40; // ~25 readings/s keeps the meter responsive without draining phones
const LED_STEP_CENTS = 5;
const LED_SIDE_COUNT = METER_RANGE_CENTS / LED_STEP_CENTS;

const $ = (id) => document.getElementById(id);

const els = {
    display: $('display'),
    leds: $('leds'),
    flagFlat: $('flag-flat'),
    flagSharp: $('flag-sharp'),
    hint: $('hint'),
    powerLed: $('power-led'),
    autoLed: $('auto-led'),
    stringRow: $('string-row'),
    pegHint: $('peg-hint'),
    footswitch: $('footswitch'),
    footswitchLabel: $('footswitch-label'),
    switchText: $('switch-text'),
    notice: $('notice'),
};

const readouts = {
    note: createSegmentDisplay($('note-seg'), 1, { dots: false }),
    octave: createSegmentDisplay($('octave-seg'), 1, { dots: false }),
    hz: createSegmentDisplay($('hz-seg'), 4),
    cent: createSegmentDisplay($('cent-seg'), 3),
};

const tuner = createTuner();
const leds = buildLeds();
const stringButtons = buildStringButtons();
const pegs = document.querySelectorAll('.peg, .hs-strings line');

let audio = null;
let starting = false;
let rafId = 0;
let lastAnalysisAt = -Infinity;

function buildLeds() {
    const list = [];
    for (let i = -LED_SIDE_COUNT; i <= LED_SIDE_COUNT; i++) {
        const led = document.createElement('span');
        const zone = i === 0 ? 'green' : Math.abs(i) <= LED_SIDE_COUNT / 2 ? 'amber' : 'red';
        led.className = `led led-${zone}`;
        led.style.setProperty('--i', String(i + LED_SIDE_COUNT));
        els.leds.appendChild(led);
        list.push(led);
    }
    return list;
}

function buildStringButtons() {
    return STRINGS.map((s) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'string-btn';
        button.dataset.string = String(s.number);
        button.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-label', `${s.number} 弦 ${s.note}${s.octave}`);
        button.innerHTML = `<span class="string-led"></span><span class="knob">${s.number}</span><span class="string-note">${s.note}${s.octave}</span>`;

        button.addEventListener('click', () => {
            const locked = tuner.state.locked === s.number ? null : s.number;
            render(tuner.lock(locked));
        });

        els.stringRow.appendChild(button);
        return button;
    });
}

els.footswitch.addEventListener('click', () => {
    if (audio) stop();
    else start();
});

async function start() {
    if (starting) return;
    hideNotice();

    if (!window.isSecureContext) {
        showNotice('需要通过 HTTPS 或 localhost 打开本页，浏览器才允许使用麦克风。');
        return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioCtx) {
        showNotice('当前浏览器不支持麦克风录音，请换用最新版的 Chrome、Safari 或 Edge。');
        return;
    }

    // Must be created synchronously in the click handler: iOS Safari only starts audio from a user gesture.
    const ctx = new AudioCtx();
    starting = true;
    setSwitch('starting');

    try {
        // Voice processing treats a sustained note as noise and rides its level, which ruins pitch readings.
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            video: false,
        });
        await ctx.resume();

        const analyser = ctx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        ctx.createMediaStreamSource(stream).connect(analyser);

        stream.getAudioTracks()[0]?.addEventListener('ended', () => {
            stop();
            showNotice('麦克风已断开，请重新开启。');
        });

        audio = { ctx, stream, analyser, buffer: new Float32Array(analyser.fftSize) };
        render(tuner.reset());
        setSwitch('on');
        bootSweep();
        rafId = requestAnimationFrame(loop);
    } catch (err) {
        ctx.close();
        setSwitch('off');
        showNotice(describeMicError(err));
        console.error('microphone start failed:', err.name, err.message);
    } finally {
        starting = false;
    }
}

function stop() {
    cancelAnimationFrame(rafId);
    if (audio) {
        audio.stream.getTracks().forEach((track) => track.stop());
        audio.ctx.close();
        audio = null;
    }
    setSwitch('off');
    render(tuner.reset());
}

function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (now - lastAnalysisAt < ANALYSIS_INTERVAL_MS) return;
    lastAnalysisAt = now;

    audio.analyser.getFloatTimeDomainData(audio.buffer);
    render(tuner.update(detectPitch(audio.buffer, audio.ctx.sampleRate), now));
}

function describeMicError(err) {
    switch (err?.name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return '麦克风权限被拒绝。请在浏览器地址栏或系统设置里允许本页使用麦克风，然后再试一次。';
        case 'NotFoundError':
        case 'OverconstrainedError':
            return '没有找到可用的麦克风。';
        case 'NotReadableError':
            return '麦克风正被其他应用占用，请关闭后再试。';
        default:
            return `麦克风开启失败（${err?.name ?? '未知错误'}），请刷新页面后重试。`;
    }
}

function setSwitch(mode) {
    const on = mode === 'on';
    els.footswitch.setAttribute('aria-pressed', String(on));
    els.footswitch.disabled = mode === 'starting';
    els.footswitchLabel.textContent = on ? '停止调音' : '开始调音';
    els.switchText.textContent = { on: '点击停止', off: '点击开始', starting: '请允许麦克风…' }[mode];
    els.powerLed.classList.toggle('on', on);
    document.body.classList.toggle('is-on', on);
}

// Power-on self test, like a hardware pedal sweeping its LEDs.
function bootSweep() {
    els.leds.classList.remove('boot');
    void els.leds.offsetWidth; // restart the CSS animation
    els.leds.classList.add('boot');
}

function showNotice(text) {
    els.notice.textContent = text;
    els.notice.hidden = false;
}

function hideNotice() {
    els.notice.hidden = true;
}

function render(state) {
    const running = audio !== null;
    els.display.classList.toggle('is-stale', state.stale);
    els.display.classList.toggle('is-active', state.active);

    renderMeter(state);
    renderReadouts(state);
    renderStrings(state);
    renderHeadstock(state);
    setText(els.hint, hintFor(state, running));
}

function renderMeter(state) {
    let lit = null;
    if (state.active) {
        lit = state.inTune ? 0 : Math.round(state.cents / LED_STEP_CENTS);
        lit = Math.max(-LED_SIDE_COUNT, Math.min(LED_SIDE_COUNT, lit));
    }
    leds.forEach((led, i) => led.classList.toggle('on', lit !== null && i - LED_SIDE_COUNT === lit));

    els.flagFlat.classList.toggle('on', state.direction === 'tighten');
    els.flagSharp.classList.toggle('on', state.direction === 'loosen');
    els.display.classList.toggle('is-in-tune', state.inTune);
}

function renderReadouts(state) {
    if (!state.active) {
        readouts.note.set('-');
        readouts.octave.set(' ');
        readouts.hz.set('----');
        readouts.cent.set('---');
        return;
    }

    readouts.note.set(state.string.note);
    readouts.octave.set(String(state.string.octave));
    readouts.hz.set(state.freq >= 100 ? state.freq.toFixed(1) : state.freq.toFixed(2));

    const c = Math.max(-99, Math.min(99, Math.round(state.cents)));
    readouts.cent.set(c < 0 ? `-${Math.abs(c)}` : String(c));
}

function renderStrings(state) {
    els.autoLed.classList.toggle('on', state.locked === null);
    for (const button of stringButtons) {
        const n = Number(button.dataset.string);
        const locked = state.locked === n;
        button.classList.toggle('is-locked', locked);
        button.classList.toggle('is-detected', state.active && state.string.number === n);
        button.classList.toggle('is-in-tune', state.active && state.inTune && state.string.number === n);
        button.setAttribute('aria-pressed', String(locked));
    }
}

function renderHeadstock(state) {
    const target = state.active ? state.string.number : state.locked;
    for (const el of pegs) {
        const match = Number(el.dataset.string) === target;
        el.classList.toggle('on', match && !(state.active && state.inTune));
        el.classList.toggle('ok', match && state.active && state.inTune);
    }

    let caption = '亮起的旋钮就是要拧的那根弦';
    if (state.active) {
        const s = state.string;
        const action = state.inTune ? '已调准' : state.direction === 'tighten' ? '拧紧，音会升高' : '拧松，音会降低';
        caption = `${s.number} 弦 ${s.note}${s.octave} · ${action}`;
    }
    setText(els.pegHint, caption);
}

function hintFor(state, running) {
    if (!running) return '按下开关开始调音';

    if (!state.active) {
        if (state.locked === null) return '请拨一根弦';
        const s = STRINGS.find((x) => x.number === state.locked);
        return `请拨 ${s.number} 弦（${s.note}${s.octave}）`;
    }

    if (state.inTune) return '音准 ✓ 可以换下一根弦';

    switch (state.warning) {
        case 'octave-high':
            return '高了一个八度！请拧松，小心断弦';
        case 'octave-low':
            return '低了一个八度，需要拧紧很多';
        case 'far':
            if (state.locked === null) return `离标准音较远：先${state.direction === 'tighten' ? '拧紧' : '拧松'}，或点下方琴弦锁定`;
            return state.direction === 'tighten' ? '偏低较多 · 继续拧紧' : '偏高较多 · 继续拧松';
        default:
            return state.direction === 'tighten' ? '偏低 · 拧紧一点' : '偏高 · 拧松一点';
    }
}

// Avoid rewriting identical text 25 times a second, which also keeps screen readers quiet.
function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
}

render(tuner.state);
