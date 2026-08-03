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
/** 25-bit total = 33,554,432 counts. Position range is 0 .. TOTAL_COUNTS-1. */
const TOTAL_COUNTS = COUNTS_PER_REV * REVOLUTIONS;

/** Factory IP. Hardware switch 2 ON forces this regardless of the programmed IP. */
const DEFAULT_ENCODER_IP = '10.10.10.10';
/** TCP 6000 carries the data stream AND the command channel on one socket. */
const DEFAULT_ENCODER_PORT = 6000;
/** disguise NavigatorDriver factory default is 8000; the reference project uses 6000. */
const DEFAULT_D3_PORT = 6000;
const D3_FACTORY_PORT = 8000;

/** Internal sensor update time, per manual FAQ 4. CycleTime below this buys nothing. */
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
  CONFIG_DUPLICATE_CONNECTION: 'd3d:config:duplicateConnection',
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
    label: 'Output type',
    help: 'ASCII_SHORT sends bare space-separated numbers and is what this app expects. BINARY is not supported for streaming.'
  },
  {
    name: 'OutputMode', group: 'output', type: 'flags',
    flags: ['Position_', 'Velocity_', 'Timestamp_'],
    label: 'Output fields',
    help: 'Which values the encoder sends, concatenated, e.g. Position_Velocity_Timestamp_.'
  },
  {
    name: 'TimeMode', group: 'output', type: 'enum',
    values: ['Polled', 'Cyclic', 'Change of state'],
    label: 'Time mode',
    help: 'Cyclic is required for a continuous stream. Polled only answers Run!. Change of state checks every 5 ms.'
  },
  {
    name: 'CycleTime', group: 'output', type: 'int', min: 1, max: 999999, unit: 'ms',
    label: 'Cycle time',
    help: 'Interval in Cyclic mode. This dominates end-to-end latency. The sensor itself only updates every ~2 ms.'
  },

  // -- scaling --------------------------------------------------------------
  {
    name: 'UsedScopeOfPhysRes', group: 'scaling', type: 'int', min: 1, max: 4294967295,
    label: 'Used scope of physical resolution', default: TOTAL_COUNTS,
    help: 'Portion of the physical resolution used, in physical steps. Must divide the total resolution evenly or the count jumps at the physical zero point.'
  },
  {
    name: 'TotalScaledRes', group: 'scaling', type: 'int', min: 1, max: 4294967295,
    label: 'Total scaled resolution', default: TOTAL_COUNTS,
    help: 'Scaled steps counted across the span defined by UsedScopeOfPhysRes.'
  },
  {
    name: 'CountingDir', group: 'scaling', type: 'enum', values: ['CW', 'CCW'],
    label: 'Counting direction',
    help: 'Which rotation direction increases the position value.'
  },
  {
    name: 'Preset', group: 'scaling', type: 'int', min: 0, max: 4294967295,
    label: 'Preset',
    // Write-only on the firmware tested here: `read Preset` answers
    // "ERROR: Preset is an unknown variable." The value it produces shows up in
    // Offset instead, which is readable. Reading it anyway would put a spurious
    // error in front of the operator on every "Read all".
    writeOnly: true,
    help: 'Sets the position value the encoder should read at its current physical position. ' +
      'Writes to flash. Cannot be read back — the resulting Offset can.'
  },
  {
    name: 'Offset', group: 'scaling', type: 'int', min: 0, max: 4294967295,
    label: 'Offset',
    help: 'Directly edits the internal offset that Preset calculates.'
  },

  // -- network --------------------------------------------------------------
  {
    name: 'IP', group: 'network', type: 'ip', danger: true, label: 'IP address',
    help: 'Only takes effect after a power cycle. If hardware switch 2 is ON the encoder stays at 10.10.10.10 whatever this says.'
  },
  { name: 'NetMask', group: 'network', type: 'ip', danger: true, label: 'Net mask',
    help: 'Encoder and server must share a subnet, or a working gateway must be set.' },
  { name: 'Gateway', group: 'network', type: 'ip', danger: true, label: 'Gateway',
    help: 'Used when the encoder and the destination are not in the same subnet.' },
  {
    name: 'AutoArpCacheUpdate', group: 'network', type: 'enum', values: ['0', '1'],
    label: 'Auto ARP cache update', default: '0',
    help: 'Enable for hot-plug-swap applications. Default off.'
  },

  // -- diagnostics ----------------------------------------------------------
  {
    name: 'Verbose', group: 'diagnostics', type: 'enum', values: ['0', '1', '2'],
    label: 'Verbosity',
    help: '0 = errors only, 1 = errors and warnings, 2 = errors, warnings and clues.'
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
