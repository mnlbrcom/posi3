'use strict';
/**
 * Shared constants: IPC channel names, encoder hardware facts and the encoder
 * variable table.
 *
 * CommonJS on purpose. Everything under src/main, src/shared and src/preload is
 * CJS; the renderer is ESM and receives whatever it needs through the preload
 * contextBridge. That keeps one module system per process boundary.
 *
 * Hardware facts below are taken from `2 - Posital Manuals/manual-ixarc-ocd-em.pdf`
 * and the OCD-EM00B-1213-C100-PRM datasheet. Do not "tidy" these numbers.
 */

// ---------------------------------------------------------------------------
// Encoder hardware — POSITAL IXARC OCD-EM00B-1213-C100-PRM
// ---------------------------------------------------------------------------

/** 13-bit singleturn: 2^13 steps per revolution. */
const COUNTS_PER_REV = 8192;
/** 12-bit multiturn: 2^12 distinguishable revolutions. */
const REVOLUTIONS = 4096;
/**
 * 25-bit total = 33,554,432 steps. Position range is 0 .. TOTAL_COUNTS-1.
 *
 * "Steps" is the manual's word and the device's own — velocity has always been
 * reported as steps/s, so calling position "counts" named one unit two ways.
 * The identifiers keep `counts` because they are persisted in every saved
 * profile and in the telemetry contract; renaming them would cost a schema
 * migration to change nothing an operator can see.
 */
const TOTAL_COUNTS = COUNTS_PER_REV * REVOLUTIONS;

/**
 * Family ceiling, manual §1.1 p.4: "a maximum resolution of 65,536 steps per
 * revolution (16 Bit) […] up to 16,384 revolutions (14 Bit). Therefore the
 * largest resulting resolution is 30 Bit = 1,073,741,824 steps."
 *
 * The scaling variables were bounded at 2^32-1 — a plain 32-bit integer limit,
 * not anything the hardware can do. Offering a range four times what any unit
 * in the family supports is an invitation to write a value it will refuse.
 */
const MAX_RESOLUTION = 1073741824;

/**
 * The physical resolution as the type label gives it: revolutions x steps per
 * revolution. Both scaling variables default to this and neither may exceed it.
 */
const PHYS_RES_TEXT = `1 – ${TOTAL_COUNTS.toLocaleString('en-US')}` +
  ` (${REVOLUTIONS.toLocaleString('en-US')} turns × ${COUNTS_PER_REV.toLocaleString('en-US')}` +
  ` steps/turn) · default ${TOTAL_COUNTS.toLocaleString('en-US')}`;

/**
 * Preset and Offset are position values, so they live inside whatever
 * TotalScaledRes is set to. Until it has been read, the ceiling shown is the
 * one TotalScaledRes itself defaults to — the type label's resolution — rather
 * than the family-wide bound, which no single device can reach.
 */
const PRESET_RANGE_TEXT =
  `0 – ${(TOTAL_COUNTS - 1).toLocaleString('en-US')} (one less than TotalScaledRes)`;

/** Factory IP. Hardware switch 2 ON forces this regardless of the programmed IP. */
const DEFAULT_ENCODER_IP = '10.10.10.10';
/** TCP 6000 carries the data stream AND the command channel on one socket. */
const DEFAULT_ENCODER_PORT = 6000;
/** disguise NavigatorDriver factory default is 8000; the reference project uses 6000. */
const DEFAULT_D3_PORT = 6000;
const D3_FACTORY_PORT = 8000;

/**
 * Internal sensor update time, manual FAQ 4: "The internal sensor update time
 * amounts ~2 ms."
 *
 * Treat this as a hint, not a floor. POSITAL give three mutually inconsistent
 * timing figures for this device:
 *
 *   manual §1.2   "you will get a cycle time of less than 2 ms" (direct 100 Mbit)
 *   manual FAQ 4  "the internal sensor update time amounts ~2 ms"
 *   datasheet     "Schnittstellen Zykluszeit: >= 10 ms"
 *
 * The first two are reconcilable — you can transmit faster than the sensor
 * samples and simply resend a value — but "a CycleTime below 2 ms buys
 * nothing" is an inference, not something the vendor states, and §1.2 markets
 * sub-2 ms operation outright.
 *
 * Measured on the reference encoder: a Run! command round-trips in 0.42 ms at
 * best (p50 2.88, max 3.62), so the transport is nowhere near the constraint.
 * What a low CycleTime actually delivers can only be established by setting one
 * — which costs a flash cycle.
 */
const SENSOR_UPDATE_MS = 2;

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const CH = {
  // invoke (renderer -> main)
  APP_INFO: 'd3d:app:info',

  CONFIG_GET: 'd3d:config:get',
  CONFIG_SAVE_CONNECTION: 'd3d:config:saveConnection',
  CONFIG_DELETE_CONNECTION: 'd3d:config:deleteConnection',
  CONFIG_REORDER: 'd3d:config:reorder',
  CONFIG_SET_SETTINGS: 'd3d:config:setSettings',
  CONFIG_EXPORT: 'd3d:config:exportFile',
  CONFIG_IMPORT: 'd3d:config:importFile',

  LINK_START: 'd3d:link:start',
  LINK_STOP: 'd3d:link:stop',
  LINK_START_ALL: 'd3d:link:startAll',
  LINK_STOP_ALL: 'd3d:link:stopAll',
  LINK_SNAPSHOT: 'd3d:link:snapshot',

  ENC_READ: 'd3d:encoder:read',
  ENC_READ_MANY: 'd3d:encoder:readMany',
  ENC_WRITE: 'd3d:encoder:write',
  ENC_WRITE_MANY: 'd3d:encoder:writeMany',
  ENC_PRESET: 'd3d:encoder:preset',
  ENC_RUN: 'd3d:encoder:run',
  ENC_RAW: 'd3d:encoder:raw',

  LOG_TAIL: 'd3d:log:tail',
  LOG_EXPORT: 'd3d:log:export',

  // The renderer is sandboxed, so it cannot require shared modules directly.
  // Pure computations it needs are served over IPC instead of weakening the
  // sandbox or duplicating the maths.
  MAPPING_COMPUTE: 'd3d:mapping:compute',

  // send (main -> renderer)
  TELEMETRY: 'd3d:telemetry',
  LINK_STATE: 'd3d:link:state',
  ENC_EVENT: 'd3d:encoder:event',
  LOG: 'd3d:log',
  CONFIG_CHANGED: 'd3d:config:changed'
};

// ---------------------------------------------------------------------------
// Link state machine
// ---------------------------------------------------------------------------

const STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  STREAMING: 'streaming',
  STALLED: 'stalled',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
  STOPPING: 'stopping'
};

// ---------------------------------------------------------------------------
// Encoder variable table (manual section 5.6.2)
//
// `danger: true`  -> changing it drops the connection or bricks reachability.
// Every write goes to flash; the encoder must not lose power mid-write.
// ---------------------------------------------------------------------------

const VAR_GROUPS = ['output', 'scaling', 'network', 'diagnostics'];

const ENCODER_VARS = [
  // -- output ---------------------------------------------------------------
  {
    name: 'OutputType', group: 'output', type: 'enum',
    values: ['ASCII', 'ASCII_SHORT', 'BINARY'],
    /**
     * Still listed, so a device already in BINARY resolves to a real option
     * and can be read and repaired — but never selectable and never writable.
     *
     * It is the one setting on this screen whose only available change is
     * breakage: the app cannot stream binary at all, so choosing it stops the
     * show, and both the break and the repair are flash writes out of a budget
     * of about 100,000.
     */
    unsupported: ['BINARY'],
    label: 'Output type',
    help: 'ASCII sends "POSITION=<POSITION> VELOCITY=<VELOCITY> TIMESTAMP=<TIME>", ' +
      'ASCII_SHORT sends "<POSITION> <VELOCITY> <TIME>", BINARY not supported'
  },
  {
    name: 'OutputMode', group: 'output', type: 'flags',
    flags: ['Position_', 'Velocity_', 'Timestamp_'],
    label: 'Output fields',
    help: 'Position — Encoder will send a scaled Position value. ' +
      'Velocity — Encoder will send a velocity Value (steps/s). ' +
      'Timestamp — Encoder will send a timestamp'
  },
  {
    name: 'TimeMode', group: 'output', type: 'enum',
    values: ['Polled', 'Cyclic', 'Change of state'],
    // The device answers in upper case (`CYCLIC`), and POSITAL's own applet
    // labels the third mode `COS`. Neither matches the manual's spelling, so
    // the dropdown has to resolve what it is given rather than compare
    // literally — otherwise it shows the operator the wrong current mode.
    aliases: { cos: 'Change of state', changeofstate: 'Change of state' },
    label: 'Time mode',
    help: 'Polled sends only when asked with Run!. Cyclic sends every CycleTime. Change of state ' +
      'sends only when the position or velocity changed, checked every 5 ms.'
  },
  {
    /**
     * Three sources, and they disagree:
     *
     *   manual §5.6.2          1 – 999,999 ms
     *   the encoder's own page  5 – 100,000 ms  (firmware 4.50)
     *   this hardware           1 ms runs
     *
     * The narrower figure was briefly enforced here on the reasoning that the
     * device is the authority — and it would have refused a value that has been
     * used successfully on this very encoder. So the range stays as documented
     * and the tighter claim is *shown* rather than imposed: a limit that blocks
     * something known to work is worse than a limit nobody enforces.
     */
    name: 'CycleTime', group: 'output', type: 'int', min: 1, max: 999999, unit: 'ms',
    label: 'Cycle time',
    range: '1 – 999,999 ms · the encoder\'s own page says 5 – 100,000',
    help: 'States the time in ms for the cyclic time mode.'
  },

  // -- scaling --------------------------------------------------------------
  {
    name: 'UsedScopeOfPhysRes', group: 'scaling', type: 'int', min: 1, max: MAX_RESOLUTION,
    label: 'Used scope of physical resolution', default: TOTAL_COUNTS,
    // The type label's figure, not the 30-bit ceiling of the product family:
    // this is a 13-bit singleturn x 12-bit multiturn unit, so the family
    // maximum is 32x more than it can hold. MAX_RESOLUTION stays as the server
    // bound, which cannot know the model.
    //
    // Written as the product rather than the total, because that is how the
    // manual gives it and how the type label reads: a bare 33,554,432 cannot be
    // checked against anything, while "4,096 turns x 8,192 steps/turn" can be
    // read straight off the label of whatever unit is actually on the rig.
    range: PHYS_RES_TEXT,
    help: 'The part of the physical resolution used, in physical steps. If it does not divide the ' +
      'total physical resolution evenly, the value jumps to zero at the physical zero point.'
  },
  {
    name: 'TotalScaledRes', group: 'scaling', type: 'int', min: 1, max: MAX_RESOLUTION,
    label: 'Total scaled resolution', default: TOTAL_COUNTS,
    range: PHYS_RES_TEXT,
    help: 'The scaled resolution counted across the physical steps defined by UsedScopeOfPhysRes.'
  },
  {
    name: 'CountingDir', group: 'scaling', type: 'enum', values: ['CW', 'CCW'],
    label: 'Counting direction',
    help: 'CW means clockwise turning increases the position value; CCW means counterclockwise does.'
  },
  {
    name: 'Preset', group: 'scaling', type: 'int', min: 0, max: MAX_RESOLUTION - 1,
    label: 'Preset',
    // Write-only on the firmware tested here: `read Preset` answers
    // "ERROR: Preset is an unknown variable." The value it produces shows up in
    // Offset instead, which is readable. Reading it anyway would put a spurious
    // error in front of the operator on every "Read all".
    writeOnly: true,
    rangeFrom: 'TotalScaledRes',
    range: PRESET_RANGE_TEXT,
    help: 'The position value the encoder will show at the point where the preset is set. An ' +
      'internal offset is calculated and added to all later positions. Cannot be read back — ' +
      'the resulting Offset can.'
  },
  {
    name: 'Offset', group: 'scaling', type: 'int', min: 0, max: MAX_RESOLUTION - 1,
    label: 'Offset',
    rangeFrom: 'TotalScaledRes',
    range: PRESET_RANGE_TEXT,
    help: 'Directly changes the offset that the preset function calculated and set.'
  },

  // -- network --------------------------------------------------------------
  {
    name: 'IP', group: 'network', type: 'ip', danger: true, label: 'IP address',
    range: 'a.b.c.d, each part 0 – 255',
    help: 'Only activated after a power cycle. If hardware switch 2 is ON the encoder stays at ' +
      '10.10.10.10 whatever this says.'
  },
  { name: 'NetMask', group: 'network', type: 'ip', danger: true, label: 'Net mask',
    range: 'a.b.c.d, each part 0 – 255',
    help: 'Encoder and PC must be in the same subnet, or a working gateway must be set.' },
  { name: 'Gateway', group: 'network', type: 'ip', danger: true, label: 'Gateway',
    range: 'a.b.c.d, each part 0 – 255',
    help: 'Used when the encoder\'s own address and the destination are not in the same subnet.' },
  {
    name: 'AutoArpCacheUpdate', group: 'network', type: 'enum', values: ['0', '1'],
    label: 'Auto ARP cache update', default: '0',
    help: 'For hot-plug-swap applications. 1 = on, 0 = off (default). Increases the response time.'
  },

  // -- diagnostics ----------------------------------------------------------
  {
    name: 'Verbose', group: 'diagnostics', type: 'enum', values: ['0', '1', '2'],
    label: 'Verbosity',
    help: 'Tracer output level. 0 = errors only, 1 = errors and warnings, 2 = errors, warnings and clues.'
  }
];

const ENCODER_VAR_BY_NAME = new Map(ENCODER_VARS.map((v) => [v.name.toLowerCase(), v]));

/** Variables the config panel reads in one sweep, in display order. */
const READ_ALL_VARS = ENCODER_VARS.map((v) => v.name);

// ---------------------------------------------------------------------------
// Timeouts and tuning
// ---------------------------------------------------------------------------

const TIMEOUTS = {
  CONNECT_MS: 4000,
  READ_MS: 2000,
  WRITE_MS: 5000,
  RUN_MS: 1500,
  /** How long to wait for the unsolicited "Parameters successfully written!". */
  FLASH_COMMIT_MS: 30000,
  /** Minimum gap between batched writes, to spare the flash. */
  WRITE_RATE_LIMIT_MS: 5000
};

const RECONNECT = { MIN_DELAY_MS: 250, MAX_DELAY_MS: 5000, FACTOR: 1.8, JITTER: 0.2 };

/** Telemetry coalescing: one IPC message for all links at this rate. */
const TELEMETRY_HZ_CHOICES = [20, 30, 60];
const DEFAULT_TELEMETRY_HZ = 30;

/** LineAssembler gives up and warns past this without seeing a newline. */
const MAX_LINE_BYTES = 65536;

const VELOCITY_POLICIES = ['zero', 'passthrough', 'derived'];
const UDP_SEND_POLICIES = ['every', 'latest'];

module.exports = {
  COUNTS_PER_REV,
  REVOLUTIONS,
  TOTAL_COUNTS,
  MAX_RESOLUTION,
  DEFAULT_ENCODER_IP,
  DEFAULT_ENCODER_PORT,
  DEFAULT_D3_PORT,
  D3_FACTORY_PORT,
  SENSOR_UPDATE_MS,
  CH,
  STATE,
  VAR_GROUPS,
  ENCODER_VARS,
  ENCODER_VAR_BY_NAME,
  READ_ALL_VARS,
  TIMEOUTS,
  RECONNECT,
  TELEMETRY_HZ_CHOICES,
  DEFAULT_TELEMETRY_HZ,
  MAX_LINE_BYTES,
  VELOCITY_POLICIES,
  UDP_SEND_POLICIES
};
