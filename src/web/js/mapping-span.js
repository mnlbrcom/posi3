/**
 * Which encoder counts sit at the ends of the range sent to disguise.
 *
 * A mirror of `inputSpan` in `src/shared/mapping.js`, which the browser cannot
 * import: that file is CommonJS and is not served. `test/mapping-span.test.js`
 * runs the same cases through both and fails if they ever disagree, which is
 * the only thing making a second copy safe.
 *
 * The dashboard used to read `mapping.maxInput` directly instead of computing
 * the span, and for mode 'full' that field is not the answer — it holds a
 * default written when the connection was created, before the encoder had ever
 * been read. On a device scaled to 300 000 counts it still said 33 554 431, so
 * the travel bar rendered 0.6% of its track where it should have shown 70%.
 * Which is to say the bar was not broken; it was being handed the wrong range.
 */

/** Nameplate figures, used only when the device has not reported its own. */
export const COUNTS_PER_REV = 8192;
export const TOTAL_COUNTS = 8192 * 4096;

/**
 * @param {object} m mapping fields, plus `countsPerRev`/`totalCounts` — pass
 *   the device's live values, not the stored ones, so a re-scaled encoder is
 *   followed rather than remembered.
 * @returns {{minInput: number, maxInput: number, totalCounts: number}}
 */
export function inputSpan(m) {
  const countsPerRev = m.countsPerRev || COUNTS_PER_REV;
  const totalCounts = m.totalCounts || TOTAL_COUNTS;
  const gear = m.gearRatio && m.gearRatio > 0 ? m.gearRatio : 1;

  if (m.mode === 'revolutions') {
    const revs = Math.max(0, Number(m.revolutions) || 1);
    return { minInput: 0, maxInput: Math.round(revs * countsPerRev * gear) - 1, totalCounts };
  }
  if (m.mode === 'capture') {
    return {
      minInput: Math.round(Number(m.minInput) || 0),
      maxInput: Math.round(Number(m.maxInput) || 0),
      totalCounts
    };
  }
  return { minInput: 0, maxInput: totalCounts - 1, totalCounts };
}
