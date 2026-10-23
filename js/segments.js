// Seven-segment LED readout drawn as inline SVG, so the display needs no web font.

const SVG_NS = 'http://www.w3.org/2000/svg';

const CELL_W = 12;
const CELL_H = 22;
const THICK = 2.4;
const GAP = 0.5;
const ADVANCE = CELL_W + 4;
const SLANT = 0.1; // horizontal shift per unit of height, for the classic italic LED look

const GLYPHS = {
    0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg',
    5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
    A: 'abcefg', B: 'cdefg', D: 'bcdeg', E: 'adefg', G: 'acdef',
    '-': 'g', ' ': '',
};

function horizontal(y, x0, x1) {
    const h = THICK / 2;
    return [[x0, y], [x0 + h, y - h], [x1 - h, y - h], [x1, y], [x1 - h, y + h], [x0 + h, y + h]];
}

function vertical(x, y0, y1) {
    const h = THICK / 2;
    return [[x, y0], [x + h, y0 + h], [x + h, y1 - h], [x, y1], [x - h, y1 - h], [x - h, y0 + h]];
}

const left = THICK / 2;
const right = CELL_W - THICK / 2;
const top = THICK / 2;
const mid = CELL_H / 2;
const bottom = CELL_H - THICK / 2;

const SEGMENT_SHAPES = {
    a: horizontal(top, left + GAP, right - GAP),
    b: vertical(right, top + GAP, mid - GAP),
    c: vertical(right, mid + GAP, bottom - GAP),
    d: horizontal(bottom, left + GAP, right - GAP),
    e: vertical(left, mid + GAP, bottom - GAP),
    f: vertical(left, top + GAP, mid - GAP),
    g: horizontal(mid, left + GAP, right - GAP),
};

function slanted(points, offsetX) {
    return points
        .map(([x, y]) => `${(x + offsetX + (CELL_H - y) * SLANT).toFixed(2)},${y.toFixed(2)}`)
        .join(' ');
}

/**
 * Fills `svg` with `cells` digit positions and returns a setter for right-aligned text.
 * A '.' lights the decimal point of the character before it.
 * Pass `{ dots: false }` for readouts that never show a decimal point.
 * Example: createSegmentDisplay(svgEl, 4).set('82.4')
 */
export function createSegmentDisplay(svg, cells, { dots = true } = {}) {
    const width = cells * ADVANCE + CELL_H * SLANT;
    svg.setAttribute('viewBox', `0 0 ${width.toFixed(2)} ${CELL_H}`);
    svg.setAttribute('aria-hidden', 'true');

    const digits = [];
    for (let i = 0; i < cells; i++) {
        const offsetX = i * ADVANCE;
        const segments = {};

        for (const [name, points] of Object.entries(SEGMENT_SHAPES)) {
            const poly = document.createElementNS(SVG_NS, 'polygon');
            poly.setAttribute('points', slanted(points, offsetX));
            poly.setAttribute('class', 'seg');
            svg.appendChild(poly);
            segments[name] = poly;
        }

        let dot = null;
        if (dots) {
            dot = document.createElementNS(SVG_NS, 'circle');
            dot.setAttribute('cx', (offsetX + CELL_W + 1.8).toFixed(2));
            dot.setAttribute('cy', bottom.toFixed(2));
            dot.setAttribute('r', '1.4');
            dot.setAttribute('class', 'seg');
            svg.appendChild(dot);
        }

        digits.push({ segments, dot });
    }

    let current = null;

    return {
        set(text) {
            if (text === current) return;
            current = text;

            // Split into characters with an optional trailing decimal point.
            const chars = [];
            for (const ch of String(text).toUpperCase()) {
                if (ch === '.' && chars.length > 0) chars[chars.length - 1].dot = true;
                else chars.push({ ch, dot: false });
            }
            while (chars.length < cells) chars.unshift({ ch: ' ', dot: false });

            digits.forEach((digit, i) => {
                const { ch, dot } = chars[chars.length - cells + i];
                const lit = GLYPHS[ch] ?? '';
                for (const [name, poly] of Object.entries(digit.segments)) {
                    poly.classList.toggle('on', lit.includes(name));
                }
                digit.dot?.classList.toggle('on', dot);
            });
        },
    };
}
