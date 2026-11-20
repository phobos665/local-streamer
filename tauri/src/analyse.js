// Frame analysis on luma (Y) arrays: no DOM, so it can be tested on its own.
//   findPicture - black borders and line multiplier ("Detect" in the Video panel).
//   flashFraction - how much of the frame just lit up (the A/V sync helper).

/** Luma from RGBA bytes (BT.709 weights), one byte per pixel. */
export function lumaOf(rgba, w, h) {
  const Y = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < Y.length; i++, j += 4) {
    Y[i] = (54 * rgba[j] + 183 * rgba[j + 1] + 19 * rgba[j + 2]) >> 8;
  }
  return Y;
}

const LIT = 40; // brighter than limited-range black (16) plus capture noise

/**
 * Finds the picture inside black borders, and whether every source line is
 * repeated a whole number of times (a line multiplier such as a RetroTINK).
 *
 * Returns { crop: {top, bottom, left, right}, factor, detail } where the crop
 * values are border sizes in pixels, factor is the line multiplier (1 when
 * none was found) and detail is false when the picture is too flat to tell.
 * With a factor above 1 the crop is snapped to whole source lines.
 * Returns { error: "black" } for an all-black frame.
 */
export function findPicture(Y, w, h) {
  const enough = (n, samples) => n >= Math.max(2, samples * 0.005);
  const litRow = (y) => {
    let n = 0;
    for (let x = 0, i = y * w; x < w; x += 2) if (Y[i + x] > LIT) n++;
    return enough(n, w / 2);
  };
  let top = 0;
  while (top < h && !litRow(top)) top++;
  if (top === h) return { error: "black" };
  let bottom = h - 1;
  while (bottom > top && !litRow(bottom)) bottom--;
  const litCol = (x) => {
    let n = 0;
    for (let y = top; y <= bottom; y += 2) if (Y[y * w + x] > LIT) n++;
    return enough(n, (bottom - top + 1) / 2);
  };
  let left = 0;
  while (left < w && !litCol(left)) left++;
  let right = w - 1;
  while (right > left && !litCol(right)) right--;

  // Mean luma change between each row and the next, across the picture.
  const rows = bottom - top + 1;
  const d = new Float64Array(Math.max(0, rows - 1));
  for (let y = top; y < bottom; y++) {
    let s = 0;
    for (let x = left, a = y * w, b = a + w; x <= right; x++) s += Math.abs(Y[a + x] - Y[b + x]);
    d[y - top] = s / (right - left + 1);
  }

  // A line multiplier of f makes rows identical within each block of f, so all
  // the change sits on every f-th row pair. Try the largest f first: a multiple
  // of the true factor has real line boundaries inside its blocks and fails.
  let factor = 1;
  let phase = 0;
  let detail = false;
  search: for (let f = 10; f >= 2; f--) {
    if (rows < f * 8) continue;
    for (let p = 0; p < f; p++) {
      let inSum = 0, inN = 0, edgeSum = 0, edgeN = 0;
      for (let i = 0; i < d.length; i++) {
        if ((((i - p) % f) + f) % f === f - 1) { edgeSum += d[i]; edgeN++; }
        else { inSum += d[i]; inN++; }
      }
      const edge = edgeSum / Math.max(1, edgeN);
      const inside = inSum / Math.max(1, inN);
      if (edge > 0.5) detail = true;
      if (edge > 0.5 && inside < edge * 0.05) {
        factor = f;
        phase = p;
        break search;
      }
    }
  }
  if (factor > 1) {
    top += phase;
    bottom = top + Math.floor((bottom + 1 - top) / factor) * factor - 1;
  }
  return {
    crop: { top, bottom: h - 1 - bottom, left, right: w - 1 - right },
    factor,
    detail: detail || factor > 1,
  };
}

/** Fraction of pixels that got much brighter since the previous frame (0..1). */
export function flashFraction(prev, cur) {
  let n = 0;
  for (let i = 0; i < cur.length; i++) if (cur[i] - prev[i] > 64) n++;
  return n / cur.length;
}
