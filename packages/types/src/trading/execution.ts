// Strategy-level execution config — how the engine reacts to signals beyond a
// single bar's fill. Lives in @kaibot/types so the backtester and the live
// executor share one vocabulary.

// What to do when an opposite-direction entry signal arrives while a position
// is already open:
//   - 'ignore'  : keep the existing position, drop the opposite signal.
//   - 'close'   : close the existing position, do NOT open the opposite one.
//   - 'reverse' : close the existing position AND open the opposite one (flip).
// The legacy backtester behaviour is 'reverse' (a flip), so that is the default.
export type OppositeSignalPolicy = 'ignore' | 'close' | 'reverse';

// Multi-timeframe declaration a plugin can surface so the runner feeds it
// aligned higher-timeframe candles. Each entry is a timeframe label in minutes
// (e.g. '240' for 4h). Only CLOSED higher-TF candles are delivered — no
// look-ahead. The base stream's own timeframe is implicit and never listed.
export interface MultiTimeframeConfig {
  additionalTimeframes: string[];
}
