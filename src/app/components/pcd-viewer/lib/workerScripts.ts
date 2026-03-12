export const SELECTION_WORKER_CODE = `
self.onmessage = function(e) {
var d = e.data;
var positions = d.positions;
var m = d.mvp;
var bitmap = d.bitmap;
var bmpW = d.bmpW;
var bmpH = d.bmpH;
var halfW = bmpW * 0.5;
var halfH = bmpH * 0.5;
var count = (positions.length / 3) | 0;
var mask = new Uint8Array(count);
var selectedCount = 0;
var m0 = m[0], m1 = m[1], m3 = m[3],
m4 = m[4], m5 = m[5], m7 = m[7],
m8 = m[8], m9 = m[9], m11 = m[11],
m12 = m[12], m13 = m[13], m15 = m[15];
for (var i = 0; i < count; i++) {
var i3 = i * 3;
var x = positions[i3];
var y = positions[i3 + 1];
var z = positions[i3 + 2];
var clipW = m3 * x + m7 * y + m11 * z + m15;
if (clipW <= 0) continue;
var invW = 1 / clipW;
var px = ((m0 * x + m4 * y + m8 * z + m12) * invW + 1) * halfW;
var py = (-(m1 * x + m5 * y + m9 * z + m13) * invW + 1) * halfH;
var ix = px | 0;
var iy = py | 0;
if (ix >= 0 && ix < bmpW && iy >= 0 && iy < bmpH && bitmap[iy * bmpW + ix]) {
mask[i] = 1;
selectedCount++;
}
}
self.postMessage(
{ mask: mask, selectedCount: selectedCount },
[mask.buffer]
);
};
`;

export const HIGHLIGHT_WORKER_CODE = `
self.onmessage = function(e) {
var positions = e.data.positions;
var mask = e.data.mask;
var count = e.data.count;
var colors = new Float32Array(count * 3);
for (var i = 0; i < count; i++) {
var i3 = i * 3;
if (mask[i]) {
colors[i3] = 0.56;
colors[i3 + 1] = 0.93;
colors[i3 + 2] = 0.56;
} else {
colors[i3] = 1.0;
colors[i3 + 1] = 1.0;
colors[i3 + 2] = 1.0;
}
}
self.postMessage(
{ positions: positions, colors: colors },
[positions.buffer, colors.buffer]
);
};
`;
