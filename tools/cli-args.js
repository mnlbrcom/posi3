'use strict';
/** Minimal `--flag value` / `--flag` parser shared by the tools. No deps. */

function parseArgs(argv, defaults) {
  const out = Object.assign({}, defaults);
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    let key = a.slice(2);
    let negate = false;
    if (key.startsWith('no-')) {
      negate = true;
      key = key.slice(3);
    }
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const cur = out[camel];
    if (typeof cur === 'boolean' || cur === undefined) {
      const next = args[i + 1];
      if (!negate && next !== undefined && !next.startsWith('--') && typeof cur !== 'boolean') {
        out[camel] = coerce(next);
        i++;
      } else {
        out[camel] = !negate;
      }
    } else {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[camel] = true;
      } else {
        out[camel] = typeof cur === 'number' ? Number(next) : coerce(next);
        i++;
      }
    }
  }
  return out;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/** Deterministic PRNG so chaos runs are reproducible from a seed. */
function makeRandom(seed) {
  let s = (seed >>> 0) || 0x2545f491;
  return function random() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

module.exports = { parseArgs, makeRandom };
