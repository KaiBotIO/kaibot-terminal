// Schema-parity lock: the executor's hand-written normalize*Params functions
// mirror the SDK Zod *ParamsSchema. This test uses the SDK schema itself as the
// oracle — for a battery of inputs (documented bounds + out-of-range probes) it
// asserts the normalizer accepts exactly what the schema accepts and rejects
// exactly what the schema rejects. If the SDK bounds move, re-mirror the
// normalizer and this turns red.
//
// NOTE: cross-package SDK import (same convention as break-even-mover.parity.
// test.ts); excluded from tsconfig, bun test runs it regardless.

import { describe, expect, it } from 'bun:test'
import type { ZodType } from 'zod'
import {
  normalizeBreakEvenParams,
  normalizeTpLadderParams,
  normalizeRiskGuardParams,
  normalizeGroupRiskGuardParams,
  normalizeDrawdownParams,
} from './registry.js'
import { breakEvenMoverParamsSchema } from '../../../../../../packages/strategy-sdk/src/managers/break-even-mover'
import { tpLadderParamsSchema } from '../../../../../../packages/strategy-sdk/src/managers/tp-ladder'
import { riskGuardParamsSchema } from '../../../../../../packages/strategy-sdk/src/managers/risk-guard'
import { groupRiskGuardParamsSchema } from '../../../../../../packages/strategy-sdk/src/managers/group-risk-guard'
import { drawdownTrailingStopParamsSchema } from '../../../../../../packages/strategy-sdk/src/managers/drawdown-trailing-stop'

type Raw = Record<string, unknown>

function accepts(fn: (raw: Raw) => unknown, input: Raw): boolean {
  try {
    fn(input)
    return true
  } catch {
    return false
  }
}

interface Case {
  name: string
  schema: ZodType
  normalize: (raw: Raw) => unknown
  base: Raw
  // Per-param probes: each merges into base and is judged by the SDK schema.
  probes: Array<{ param: string; values: unknown[] }>
}

const CASES: Case[] = [
  {
    name: 'break-even-mover',
    schema: breakEvenMoverParamsSchema,
    normalize: normalizeBreakEvenParams,
    base: {},
    probes: [
      { param: 'feePercentage', values: [-0.1, 0, 0.5, 1, 1.0001] },
      { param: 'triggerPercentage', values: [-1, 0, 50, 100, 100.1] },
      { param: 'referencePrice', values: [-1, 0, 100] },
      { param: 'useEntryReference', values: [true, false] },
    ],
  },
  {
    name: 'tp-ladder',
    schema: tpLadderParamsSchema,
    normalize: normalizeTpLadderParams,
    base: { target: 120 }, // satisfy the prices-or-target refinement
    probes: [
      { param: 'levelCount', values: [0, 1, 6, 7, 3.5] },
      { param: 'fractionPerTranche', values: [-0.1, 0, 0.5, 1, 1.1] },
      { param: 'runnerFraction', values: [-0.1, 0, 1, 1.1] },
      { param: 'target', values: [-5, 0, 120] },
      { param: 'prices', values: [[110, 120], [-1], []] },
    ],
  },
  {
    name: 'risk-guard',
    schema: riskGuardParamsSchema,
    normalize: normalizeRiskGuardParams,
    base: {},
    probes: [
      { param: 'maxSize', values: [-1, 0, 10] },
      { param: 'globalStopPrice', values: [-1, 0, 90] },
      { param: 'releaseLockAfter', values: [-1, 0, 5] },
    ],
  },
  {
    name: 'group-risk-guard',
    schema: groupRiskGuardParamsSchema,
    normalize: normalizeGroupRiskGuardParams,
    base: {},
    probes: [
      { param: 'maxGroupLossFraction', values: [-0.1, 0, 0.5, 1, 1.1] },
      { param: 'maxGroupNotional', values: [-1, 0, 1000] },
    ],
  },
  {
    name: 'drawdown-trailing-stop',
    schema: drawdownTrailingStopParamsSchema,
    normalize: normalizeDrawdownParams,
    base: {},
    probes: [
      { param: 'maxTrailingPercentage', values: [-1, 0, 100, 100.1] },
      { param: 'maxTrailingPoints', values: [-1, 0, 500] },
      { param: 'minTrailingPercentage', values: [-1, 0, 100, 100.1] },
      { param: 'minTrailingPoints', values: [-1, 0, 50] },
      { param: 'referencePrice', values: [-1, 0, 100] },
      { param: 'trailingLock', values: [true, false] },
      { param: 'onlyWhenProfit', values: [true, false] },
      { param: 'freezeExtreme', values: [true, false] },
    ],
  },
]

describe('normalizeParams schema parity with the SDK', () => {
  for (const c of CASES) {
    it(`${c.name}: normalizer accept/reject matches the SDK schema`, () => {
      // Baseline: whatever the schema does with the defaults, the normalizer
      // must agree (guards are the intentional exception, asserted below).
      if (c.name !== 'risk-guard' && c.name !== 'group-risk-guard') {
        expect(accepts(c.normalize, c.base)).toBe(c.schema.safeParse(c.base).success)
      }
      for (const probe of c.probes) {
        for (const value of probe.values) {
          const input = { ...c.base, [probe.param]: value }
          const schemaOk = c.schema.safeParse(input).success
          const normOk = accepts(c.normalize, input)
          expect(normOk, `${c.name}.${probe.param}=${JSON.stringify(value)} schema=${schemaOk} norm=${normOk}`).toBe(
            schemaOk,
          )
        }
      }
    })
  }

  // Documented, intentional divergence: the guard normalizers require at least
  // one threshold (an empty guard attach is meaningless), while the SDK schema
  // leaves every field optional and accepts {}. Everything else stays in parity.
  it('guard normalizers reject the empty object the SDK schema accepts', () => {
    expect(riskGuardParamsSchema.safeParse({}).success).toBe(true)
    expect(accepts(normalizeRiskGuardParams, {})).toBe(false)
    expect(groupRiskGuardParamsSchema.safeParse({}).success).toBe(true)
    expect(accepts(normalizeGroupRiskGuardParams, {})).toBe(false)
  })
})
