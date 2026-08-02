'use strict';
/**
 * The maths behind the disguise mapping helper.
 *
 * Pure functions, shared by main and (via preload) the renderer, so the numbers
 * shown in the UI are the same ones the checks are run against.
 *
 * Target is the ScreenPositionAxis in d3: min_input / max_input / min_output /
 * max_output / wrapinput. Those field names are taken verbatim from the sample
 * project's axis record so they can be typed straight across.
 */

const { COUNTS_PER_REV, TOTAL_COUNTS, D3_FACTORY_PORT } = require('./constants');

/**
 * Work out the input span for a mapping.
 * @param {object} m
 * @param {'full'|'revolutions'|'capture'} m.mode
 * @param {number} [m.revolutions]  for mode 'revolutions'
 * @param {number} [m.minInput]     for mode 'capture'
 * @param {number} [m.maxInput]     for mode 'capture'
 * @param {number} [m.countsPerRev]
 * @param {number} [m.totalCounts]
 * @param {number} [m.gearRatio]    encoder turns per driven turn
 */
function inputSpan(m) {
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

/**
 * Full result for the helper panel: the d3 field values plus any warnings.
 */
function computeMapping(m) {
  const span = inputSpan(m);
  const countsPerRev = m.countsPerRev || COUNTS_PER_REV;
  const totalCounts = span.totalCounts;

  const minOutput = Number(m.minOutput) || 0;
  const maxOutput = m.maxOutput === undefined || m.maxOutput === null ? 1 : Number(m.maxOutput);

  let { minInput, maxInput } = span;
  const warnings = [];
  let reversed = false;
  let crossesWrap = false;

  if (maxInput < minInput) {
    // Captured backwards, or the axis was driven the "wrong" way. Either the
    // encoder's CountingDir is inverted relative to the rig, or the span really
    // does run through the rollover.
    reversed = true;
    crossesWrap = true;
    warnings.push({
      level: 'warn',
      text: 'The captured span runs through the 0 / ' + totalCounts.toLocaleString() +
        ' rollover. Either flip CountingDir on the encoder, or use Zero/Preset to move ' +
        'the rollover outside the working range.',
      action: 'preset'
    });
  }

  const rawSpan = reversed
    ? (totalCounts - minInput) + maxInput
    : maxInput - minInput;

  if (rawSpan <= 0) {
    warnings.push({ level: 'error', text: 'The input span is zero — capture two different positions.' });
  }

  const revsUsed = rawSpan / countsPerRev;
  const outputSpan = maxOutput - minOutput;
  const unitsPerCount = rawSpan > 0 ? outputSpan / rawSpan : 0;

  if (rawSpan > 0 && rawSpan < countsPerRev / 100) {
    warnings.push({
      level: 'warn',
      text: `The span is only ${rawSpan} counts (${(revsUsed * 360).toFixed(1)}° of rotation). ` +
        'Small spans amplify encoder noise into visible jitter.'
    });
  }

  return {
    minInput,
    maxInput,
    minOutput,
    maxOutput,
    wrapInput: crossesWrap || m.wrapInput !== false,
    property: m.property || 'offset.x',
    object: m.object || '',
    rawSpan,
    revsUsed,
    unitsPerCount,
    countsPerRev,
    totalCounts,
    crossesWrap,
    reversed,
    warnings
  };
}

/**
 * Preset value that moves the rollover to the far side of a working range,
 * so a span no longer straddles it. Places the span's start a quarter turn in.
 */
function suggestedPreset(minInput, countsPerRev = COUNTS_PER_REV) {
  return Math.round(countsPerRev / 4);
}

/**
 * Everything to type into d3, as label/value rows the UI can render directly.
 * @param {object} conn  the connection (for devid and destination port)
 * @param {object} mapped result of computeMapping
 */
function d3Fields(conn, mapped) {
  const port = conn.d3.port;
  return [
    {
      section: 'NavigatorDriver',
      rows: [
        {
          key: 'port',
          value: String(port),
          note: port === D3_FACTORY_PORT
            ? "matches disguise's factory default"
            : `disguise defaults this to ${D3_FACTORY_PORT} — change it to ${port}`
        },
        { key: 'multicastaddress', value: '', note: 'leave empty for plain unicast' },
        { key: 'ipfromfilter', value: '', note: 'leave empty unless filtering by source IP' }
      ]
    },
    {
      section: 'ScreenPositionAxis',
      rows: [
        { key: 'id', value: String(conn.d3.devid), note: 'must match this connection’s device ID' },
        { key: 'object', value: mapped.object || 'objects/screen2/surface 1.apx', note: 'the object to drive' },
        { key: 'property', value: mapped.property, note: 'a disguise expression, e.g. offset.x' },
        { key: 'min_input', value: String(mapped.minInput), note: 'encoder counts' },
        { key: 'max_input', value: String(mapped.maxInput), note: 'encoder counts' },
        { key: 'min_output', value: String(mapped.minOutput), note: '' },
        { key: 'max_output', value: String(mapped.maxOutput), note: '' },
        { key: 'wrapinput', value: mapped.wrapInput ? 'true' : 'false', note: mapped.crossesWrap ? 'required — the span crosses the rollover' : '' },
        {
          key: 'velocitycalcmode',
          value: 'from position',
          note: 'this bridge sends velocity 0 by default, so disguise must derive it'
        }
      ]
    }
  ];
}

module.exports = { inputSpan, computeMapping, suggestedPreset, d3Fields };
