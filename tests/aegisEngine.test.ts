import { describe, expect, it } from 'vitest'
import type {
  DepartmentTokenRecord,
  RoutingPolicyConfig,
  UserInteractionTelemetry,
  WorkflowRoutingDetail
} from '../src/types/aegis'
import { DEPARTMENT_WORKFLOWS } from '../src/data/enterpriseSeed'
import {
  CONTEXT_RULES,
  PRUNED_BLOAT_TOKENS,
  SQL_BENCHMARK_CASES
} from '../src/data/sqlBenchmarks'
import {
  EDIT_DIFF_SNIPPET_LIBRARY,
  MANUAL_INSTRUCTION_EVENTS,
  TELEMETRY_SESSIONS,
  generateTelemetrySessions
} from '../src/data/telemetryLogs'
import {
  DEFAULT_ROUTING_POLICY,
  MODEL_TIER_PRICING,
  computeGrossValueGeneratedUsd,
  computePrunableContextTokens,
  computeWorkflowRoiMetrics,
  resolveRoutedModelTier,
  simulateAdaptiveRouting
} from '../src/engine/tokenFinOpsEngine'
import {
  computeContextTokenOverhead,
  countPassedSqlBenchmarks,
  evaluateSqlBenchmarkAccuracy
} from '../src/engine/contextAblationEngine'
import {
  aggregateTelemetrySessions,
  clusterUserEdits,
  selectHighFrictionSessions,
  simulateTelemetryAfterAutopilot
} from '../src/engine/productTelemetryEngine'
import {
  applyAutopilotToRuleIds,
  runClosedLoopOptimizationCycle
} from '../src/engine/closedLoopAutopilot'
import {
  CAUSE_LEVEL_MIN_BREADTH,
  REPETITION_TRIGGER_THRESHOLD,
  SYSTEMIC_FLAW_MIN_UNIQUE_USERS,
  classifyRepetitionTriggers,
  computeLivingSignalSummary,
  computeManualEffortIndex,
  computeRemediationBreadthCount,
  evaluateDualRuleSurvival,
  evaluateSymptomVsCause,
  normalizeInstructionText
} from '../src/engine/livingLoopDiagnosticEngine'

const BASELINE_RULE_IDS = CONTEXT_RULES.filter((rule) => rule.baselineInclusion).map(
  (rule) => rule.ruleId
)
const CLOSED_LOOP_RULE_IDS = CONTEXT_RULES.filter(
  (rule) => rule.recommendedAction === 'retain_core' || rule.recommendedAction === 'auto_inject_patch'
).map((rule) => rule.ruleId)

const ROUTING_AND_CACHE_POLICY: RoutingPolicyConfig = {
  ...DEFAULT_ROUTING_POLICY,
  enableSemanticCaching: true
}

const FULL_OPTIMIZATION_POLICY: RoutingPolicyConfig = {
  ...DEFAULT_ROUTING_POLICY,
  enableSemanticCaching: true,
  pruneLowValueContextRules: true
}

function buildToyWorkflow(overrides: Partial<DepartmentTokenRecord> = {}): DepartmentTokenRecord {
  return {
    id: 'wf_toy_01',
    department: 'product_eng',
    departmentLabel: 'Product Engineering',
    workflowName: 'Toy Workload For Exact Math',
    monthlyPromptCount: 1_000,
    avgInputTokens: 1_000,
    avgOutputTokens: 500,
    currentModelTier: 'frontier_reasoning',
    inputCostPer1M: 15.0,
    outputCostPer1M: 60.0,
    monthlyApiSpendUsd: 45.0,
    verifiedOutcomesCount: 100,
    outcomeUnitLabel: 'toy outcomes',
    hoursSavedPerOutcome: 0.1,
    hourlyLoadedWageUsd: 50,
    directRevenueAttributedUsd: 0,
    avgComplexityScore: 0.9,
    semanticCacheHitPotential: 0.8,
    ...overrides
  }
}

describe('Token FinOps & Adaptive Routing', () => {
  it('seeds 12 workflows spanning all 5 departments', () => {
    expect(DEPARTMENT_WORKFLOWS).toHaveLength(12)
    const departments = new Set(DEPARTMENT_WORKFLOWS.map((record) => record.department))
    expect(departments.size).toBe(5)
  })

  it('derives monthlyApiSpendUsd from volume, token sizes, and tier pricing for all 12 workflows', () => {
    for (const record of DEPARTMENT_WORKFLOWS) {
      const recomputed =
        (record.monthlyPromptCount *
          (record.avgInputTokens * record.inputCostPer1M +
            record.avgOutputTokens * record.outputCostPer1M)) /
        1_000_000
      expect(record.monthlyApiSpendUsd).toBeCloseTo(recomputed, 10)
    }
  })

  it('keeps seed tier pricing aligned with the engine pricing table', () => {
    for (const record of DEPARTMENT_WORKFLOWS) {
      expect(record.inputCostPer1M).toBe(
        MODEL_TIER_PRICING[record.currentModelTier].inputCostPer1M
      )
      expect(record.outputCostPer1M).toBe(
        MODEL_TIER_PRICING[record.currentModelTier].outputCostPer1M
      )
    }
  })

  it('computes finite, formula-exact gross value, net ROI, and cost per verified outcome for all 12 workflows', () => {
    for (const record of DEPARTMENT_WORKFLOWS) {
      const metrics = computeWorkflowRoiMetrics(record)
      expect(Number.isFinite(metrics.grossValueGeneratedUsd)).toBe(true)
      expect(Number.isFinite(metrics.netRoiRatio)).toBe(true)
      expect(Number.isFinite(metrics.costPerVerifiedOutcome)).toBe(true)
      expect(metrics.grossValueGeneratedUsd).toBeGreaterThan(0)
      expect(metrics.costPerVerifiedOutcome).toBeGreaterThanOrEqual(0)
    }

    const tierOneTickets = DEPARTMENT_WORKFLOWS.find((record) => record.id === 'wf_cs_01')
    expect(tierOneTickets).toBeDefined()
    if (tierOneTickets !== undefined) {
      expect(computeGrossValueGeneratedUsd(tierOneTickets)).toBeCloseTo(
        tierOneTickets.verifiedOutcomesCount * tierOneTickets.hoursSavedPerOutcome * tierOneTickets.hourlyLoadedWageUsd +
          tierOneTickets.directRevenueAttributedUsd,
        6
      )
      const metrics = computeWorkflowRoiMetrics(tierOneTickets)
      expect(metrics.netRoiRatio).toBeCloseTo(
        (computeGrossValueGeneratedUsd(tierOneTickets) - tierOneTickets.monthlyApiSpendUsd) /
          tierOneTickets.monthlyApiSpendUsd,
        10
      )
      expect(metrics.costPerVerifiedOutcome).toBeCloseTo(
        tierOneTickets.monthlyApiSpendUsd / Math.max(1, tierOneTickets.verifiedOutcomesCount),
        10
      )
    }
  })

  it('contains at least one negative-ROI token-burn workflow at baseline', () => {
    const burning = DEPARTMENT_WORKFLOWS.filter(
      (record) => computeWorkflowRoiMetrics(record).netRoiRatio < 0
    )
    expect(burning.length).toBeGreaterThanOrEqual(1)
    expect(burning.every((record) => record.currentModelTier === 'frontier_reasoning')).toBe(true)
  })
})

describe('Adaptive Routing, Semantic Caching & Context Pruning', () => {
  it('routes complexity scores into the correct model tiers at the default thresholds', () => {
    expect(resolveRoutedModelTier(0.34, DEFAULT_ROUTING_POLICY)).toBe('quantized_local_8b')
    expect(resolveRoutedModelTier(0.35, DEFAULT_ROUTING_POLICY)).toBe('flash_workhorse')
    expect(resolveRoutedModelTier(0.71, DEFAULT_ROUTING_POLICY)).toBe('flash_workhorse')
    expect(resolveRoutedModelTier(0.72, DEFAULT_ROUTING_POLICY)).toBe('frontier_reasoning')
  })

  it('clamps an inverted flash threshold to the frontier boundary', () => {
    const inverted: RoutingPolicyConfig = {
      complexityThresholdForFrontier: 0.6,
      complexityThresholdForFlash: 0.9,
      enableSemanticCaching: false,
      pruneLowValueContextRules: false
    }
    // The flash band collapses: every score below the frontier boundary demotes
    // to the quantized tier, mirroring the literal spec formula.
    expect(resolveRoutedModelTier(0.3, inverted)).toBe('quantized_local_8b')
    expect(resolveRoutedModelTier(0.59, inverted)).toBe('quantized_local_8b')
    expect(resolveRoutedModelTier(0.6, inverted)).toBe('frontier_reasoning')
    expect(resolveRoutedModelTier(0.75, inverted)).toBe('frontier_reasoning')
  })

  it('strictly reduces spend in every department with routing + caching while preserving outcomes', () => {
    const routing = simulateAdaptiveRouting(
      DEPARTMENT_WORKFLOWS,
      ROUTING_AND_CACHE_POLICY,
      CONTEXT_RULES
    )
    expect(routing.departmentRoi).toHaveLength(5)
    for (const row of routing.departmentRoi) {
      expect(row.optimizedSpendUsd).toBeLessThan(row.baselineSpendUsd)
      expect(row.monthlySavingsUsd).toBeGreaterThan(0)
    }
    expect(routing.totalOptimizedSpendUsd).toBeLessThan(routing.totalBaselineSpendUsd)

    const seedOutcomes = DEPARTMENT_WORKFLOWS.reduce(
      (sum, record) => sum + record.verifiedOutcomesCount,
      0
    )
    const seedValue = DEPARTMENT_WORKFLOWS.reduce(
      (sum, record) => sum + computeGrossValueGeneratedUsd(record),
      0
    )
    expect(routing.totalVerifiedOutcomes).toBe(seedOutcomes)
    expect(routing.totalGrossValueUsd).toBeCloseTo(seedValue, 6)
  })

  it('computes exact semantic-cache economics: 85% of hit potential is served at $0.10/1M', () => {
    const toy = buildToyWorkflow()
    const routing = simulateAdaptiveRouting([toy], {
      ...DEFAULT_ROUTING_POLICY,
      complexityThresholdForFrontier: 0.5,
      complexityThresholdForFlash: 0.25,
      enableSemanticCaching: true
    }, CONTEXT_RULES)
    const detail: WorkflowRoutingDetail | undefined = routing.workflowDetails[0]
    expect(detail).toBeDefined()
    if (detail === undefined) return
    expect(detail.routedModelTier).toBe('frontier_reasoning')
    expect(detail.cachedFraction).toBeCloseTo(0.8 * 0.85, 10)
    // billable volume + cache lookup cost, frontier rates
    const expectedOptimized =
      (1_000 * 1_000 * (1 - 0.68) * 15.0 + 1_000 * 500 * (1 - 0.68) * 60.0) / 1_000_000 +
      (1_000 * 1_000 * 0.68 * 0.1) / 1_000_000
    expect(detail.optimizedSpendUsd).toBeCloseTo(expectedOptimized, 8)
    expect(detail.optimizedSpendUsd).toBeLessThan(toy.monthlyApiSpendUsd)

    const withoutCache = simulateAdaptiveRouting([toy], {
      ...DEFAULT_ROUTING_POLICY,
      complexityThresholdForFrontier: 0.5,
      complexityThresholdForFlash: 0.25,
      enableSemanticCaching: false
    }, CONTEXT_RULES)
    expect(withoutCache.workflowDetails[0]?.optimizedSpendUsd).toBeCloseTo(45.0, 8)
  })

  it('subtracts the full prune_bloat token weight from inputs when pruning is enabled', () => {
    expect(computePrunableContextTokens(CONTEXT_RULES)).toBe(PRUNED_BLOAT_TOKENS)
    expect(PRUNED_BLOAT_TOKENS).toBe(680)

    const toy = buildToyWorkflow()
    const routing = simulateAdaptiveRouting([toy], {
      ...DEFAULT_ROUTING_POLICY,
      complexityThresholdForFrontier: 0.5,
      complexityThresholdForFlash: 0.25,
      enableSemanticCaching: false,
      pruneLowValueContextRules: true
    }, CONTEXT_RULES)
    const detail: WorkflowRoutingDetail | undefined = routing.workflowDetails[0]
    expect(detail).toBeDefined()
    if (detail === undefined) return
    expect(detail.prunedInputTokens).toBe(680)
    const expectedOptimized =
      (1_000 * (1_000 - 680) * 15.0 + 1_000 * 500 * 60.0) / 1_000_000
    expect(detail.optimizedSpendUsd).toBeCloseTo(expectedOptimized, 8)
  })

  it('flips every negative-ROI burn workflow to positive ROI under routing + caching + pruning', () => {
    const routing = simulateAdaptiveRouting(
      DEPARTMENT_WORKFLOWS,
      FULL_OPTIMIZATION_POLICY,
      CONTEXT_RULES
    )
    const baselineBurners = DEPARTMENT_WORKFLOWS.filter(
      (record) => computeWorkflowRoiMetrics(record).netRoiRatio < 0
    ).map((record) => record.id)
    expect(baselineBurners.length).toBeGreaterThanOrEqual(1)
    for (const recordId of baselineBurners) {
      const detail = routing.workflowDetails.find((row) => row.recordId === recordId)
      expect(detail).toBeDefined()
      if (detail !== undefined) {
        expect(detail.netRoiRatioOptimized).toBeGreaterThan(0)
        expect(detail.optimizedSpendUsd).toBeLessThan(detail.baselineSpendUsd)
      }
    }
  })
})

describe('SQL Benchmark Staging & Shapley Context Ablation', () => {
  it('stages exactly 35% uncontextualized, 70% with manual static context, 95% closed-loop', () => {
    expect(SQL_BENCHMARK_CASES).toHaveLength(20)
    expect(evaluateSqlBenchmarkAccuracy([], SQL_BENCHMARK_CASES)).toBeCloseTo(35, 10)
    expect(countPassedSqlBenchmarks([], SQL_BENCHMARK_CASES)).toBe(7)
    expect(evaluateSqlBenchmarkAccuracy(BASELINE_RULE_IDS, SQL_BENCHMARK_CASES)).toBeCloseTo(70, 10)
    expect(countPassedSqlBenchmarks(BASELINE_RULE_IDS, SQL_BENCHMARK_CASES)).toBe(14)
    expect(evaluateSqlBenchmarkAccuracy(CLOSED_LOOP_RULE_IDS, SQL_BENCHMARK_CASES)).toBeCloseTo(95, 10)
    expect(countPassedSqlBenchmarks(CLOSED_LOOP_RULE_IDS, SQL_BENCHMARK_CASES)).toBe(19)
  })

  it('matches the seeded stage flags with live recomputation', () => {
    const uncontextualizedPasses = SQL_BENCHMARK_CASES.filter(
      (benchmark) => benchmark.uncontextualizedPassed
    )
    const manualPasses = SQL_BENCHMARK_CASES.filter(
      (benchmark) => benchmark.afterManualContextPassed
    )
    const autopilotPasses = SQL_BENCHMARK_CASES.filter(
      (benchmark) => benchmark.afterAutopilotPatchPassed
    )
    expect(uncontextualizedPasses).toHaveLength(7)
    expect(manualPasses).toHaveLength(14)
    expect(autopilotPasses).toHaveLength(19)
  })

  it('gives prune_bloat rules zero gain and non-positive efficiency while core/patch rules stay positive', () => {
    const bloatRules = CONTEXT_RULES.filter((rule) => rule.recommendedAction === 'prune_bloat')
    const valuableRules = CONTEXT_RULES.filter(
      (rule) => rule.recommendedAction !== 'prune_bloat'
    )
    expect(bloatRules).toHaveLength(2)
    for (const rule of bloatRules) {
      expect(rule.marginalAccuracyGainPct).toBe(0)
      expect(rule.efficiencyScorePer100Tokens).toBeLessThanOrEqual(0)
      expect(rule.tokenWeight).toBeGreaterThanOrEqual(340)
      expect(rule.ruleText.length).toBeGreaterThan(1_500)
    }
    expect(valuableRules).toHaveLength(8)
    for (const rule of valuableRules) {
      expect(rule.marginalAccuracyGainPct).toBeGreaterThan(0)
      expect(rule.efficiencyScorePer100Tokens).toBeGreaterThan(0)
    }
    const softDelete = CONTEXT_RULES.find((rule) => rule.ruleId === 'ctx_core_soft_delete')
    expect(softDelete).toBeDefined()
    if (softDelete !== undefined) {
      expect(softDelete.efficiencyScorePer100Tokens).toBeCloseTo((15 / 60) * 100, 8)
    }
  })

  it('computes context token overhead of 930 baseline and 435 closed-loop tokens per query', () => {
    expect(computeContextTokenOverhead(BASELINE_RULE_IDS, CONTEXT_RULES)).toBe(930)
    expect(computeContextTokenOverhead(CLOSED_LOOP_RULE_IDS, CONTEXT_RULES)).toBe(435)
  })
})

describe('Product Telemetry & Edit-Diff Forensics', () => {
  it('generates 120 deterministic sessions across all 4 surfaces and 5 departments', () => {
    expect(TELEMETRY_SESSIONS).toHaveLength(120)
    const surfaces = new Set(TELEMETRY_SESSIONS.map((session) => session.featureSurface))
    expect(surfaces.size).toBe(4)
    for (const surface of ['sql_copilot', 'exec_narrative_gen', 'ticket_triage_agent', 'forecast_explainer']) {
      expect(TELEMETRY_SESSIONS.filter((session) => session.featureSurface === surface)).toHaveLength(30)
    }
    const departments = new Set(TELEMETRY_SESSIONS.map((session) => session.department))
    expect(departments.size).toBe(5)
  })

  it('is byte-for-byte reproducible across generator runs', () => {
    expect(generateTelemetrySessions()).toEqual(TELEMETRY_SESSIONS)
  })

  it('reconciles productive + wasted spend to total trajectory spend across all 120 sessions', () => {
    const summary = aggregateTelemetrySessions(TELEMETRY_SESSIONS)
    expect(summary.totalSessions).toBe(120)
    expect(summary.productiveSpendUsd + summary.wastedRecoverySpendUsd).toBeCloseTo(
      summary.totalTrajectorySpendUsd,
      8
    )
    for (const session of TELEMETRY_SESSIONS) {
      expect(session.wastedRecoveryCostUsd).toBeLessThanOrEqual(session.totalTrajectoryCostUsd)
      expect(session.wastedRecoveryCostUsd).toBeGreaterThanOrEqual(0)
    }
    const asIs = TELEMETRY_SESSIONS.filter((session) => session.userOutcome === 'accepted_as_is')
    for (const session of asIs) {
      expect(session.wastedRecoveryCostUsd).toBe(0)
      expect(session.regenerationCount).toBe(0)
    }
  })

  it('splits the acceptance funnel to exactly 100% with the seeded 50/44/26 mix', () => {
    const summary = aggregateTelemetrySessions(TELEMETRY_SESSIONS)
    expect(summary.acceptedAsIsCount).toBe(50)
    expect(summary.acceptedAfterEditCount).toBe(44)
    expect(summary.rejectedAbandonedCount).toBe(26)
    expect(summary.acceptedAsIsPct + summary.acceptedAfterEditPct + summary.rejectedAbandonedPct).toBeCloseTo(100, 8)
    expect(summary.editRatePct).toBeCloseTo((44 + 26) / 120 * 100, 8)
    expect(summary.costPerAcceptedOutputUsd).toBeGreaterThan(0)
  })

  it('clusters recurring failure categories with valid proposed context patch rules, ranked by waste', () => {
    const clusters = clusterUserEdits(TELEMETRY_SESSIONS, CONTEXT_RULES)
    expect(clusters).toHaveLength(4)
    expect(clusters.map((cluster) => cluster.rootFailureCategory).sort()).toEqual([
      'currency_join_error',
      'hallucinated_column',
      'missing_fiscal_calendar',
      'soft_delete_leakage'
    ])
    const countsByCategory = new Map(clusters.map((cluster) => [cluster.rootFailureCategory, cluster.affectedSessionsCount]))
    expect(countsByCategory.get('missing_fiscal_calendar')).toBe(16)
    expect(countsByCategory.get('soft_delete_leakage')).toBe(14)
    expect(countsByCategory.get('currency_join_error')).toBe(12)
    expect(countsByCategory.get('hallucinated_column')).toBe(10)
    for (let index = 1; index < clusters.length; index += 1) {
      expect(clusters[index - 1].monthlyWastedTokenSpendUsd).toBeGreaterThanOrEqual(
        clusters[index].monthlyWastedTokenSpendUsd
      )
    }
    for (const cluster of clusters) {
      const proposed = CONTEXT_RULES.find((rule) => rule.ruleId === cluster.proposedContextPatchRule.ruleId)
      expect(proposed).toBeDefined()
      expect(cluster.sampleAgentOutputSnippet.length).toBeGreaterThan(10)
      expect(cluster.sampleUserCorrectedSnippet.length).toBeGreaterThan(10)
    }
  })

  it('respects the clustering predicate: every clustered session is high-friction', () => {
    const eligible = selectHighFrictionSessions(TELEMETRY_SESSIONS)
    expect(eligible).toHaveLength(52)
    for (const session of eligible) {
      expect(
        session.editDistanceRatio > 0.15 || session.explicitFeedback === 'thumbs_down'
      ).toBe(true)
      expect(session.rootFailureCategory).not.toBe('none')
    }
    const verbose = TELEMETRY_SESSIONS.filter(
      (session) => session.rootFailureCategory === 'verbose_formatting'
    )
    expect(verbose).toHaveLength(8)
    for (const session of verbose) {
      expect(session.editDistanceRatio).toBeLessThanOrEqual(0.15)
      expect(session.explicitFeedback).not.toBe('thumbs_down')
    }
  })

  it('remediates exactly the 52 mapped sessions once patch rules are active', () => {
    const remediated = simulateTelemetryAfterAutopilot(TELEMETRY_SESSIONS, CLOSED_LOOP_RULE_IDS)
    const changed = remediated.filter((session, index) => session !== TELEMETRY_SESSIONS[index])
    expect(changed).toHaveLength(52)
    const afterSummary = aggregateTelemetrySessions(remediated)
    expect(afterSummary.acceptedAsIsCount).toBe(102)
    expect(afterSummary.editRatePct).toBeCloseTo(18 / 120 * 100, 8)
    for (const session of changed) {
      expect(session.userOutcome).toBe('accepted_as_is')
      expect(session.wastedRecoveryCostUsd).toBe(0)
      expect(session.regenerationCount).toBe(0)
      expect(session.totalTrajectoryCostUsd).toBeGreaterThan(0)
    }
    const verboseUntouched = remediated.filter(
      (session) => session.rootFailureCategory === 'verbose_formatting'
    )
    expect(verboseUntouched).toHaveLength(8)
    expect(remediated[0]).toBe(TELEMETRY_SESSIONS[0])
  })
})

describe('Closed-Loop Autopilot Cycle', () => {
  const cycle = runClosedLoopOptimizationCycle(
    DEFAULT_ROUTING_POLICY,
    CONTEXT_RULES,
    SQL_BENCHMARK_CASES,
    TELEMETRY_SESSIONS
  )

  it('promotes all three edit-derived patches and prunes both bloat rules', () => {
    expect(cycle.iterationNumber).toBe(1)
    expect(cycle.appliedPatchRuleIds).toHaveLength(3)
    expect(cycle.appliedPatchRuleIds).toEqual(
      expect.arrayContaining([
        'ctx_patch_fiscal_calendar',
        'ctx_patch_fx_effective_date_join',
        'ctx_patch_sandbox_org_exclusion'
      ])
    )
    expect(cycle.prunedBloatRuleIds).toEqual([
      'ctx_bloat_legacy_style_guide',
      'ctx_bloat_governance_boilerplate'
    ])
  })

  it('lifts SQL accuracy from 70% to 95% while cutting edit and regeneration rates', () => {
    expect(cycle.sqlBenchmarkAccuracyBeforePct).toBeCloseTo(70, 10)
    expect(cycle.sqlBenchmarkAccuracyAfterPct).toBeCloseTo(95, 10)
    expect(cycle.productEditRateBeforePct).toBeCloseTo(58.333333, 6)
    expect(cycle.productEditRateAfterPct).toBeCloseTo(15, 8)
    expect(cycle.productEditRateAfterPct).toBeLessThan(cycle.productEditRateBeforePct)
    expect(cycle.regenerationRateAfterPct).toBeLessThan(cycle.regenerationRateBeforePct)
    expect(cycle.costPerAcceptedOutputAfterUsd).toBeLessThan(cycle.costPerAcceptedOutputBeforeUsd)
  })

  it('cuts the Manual Effort Index from 160.83 to 22.5 corrections per 100 sessions', () => {
    expect(cycle.manualEffortIndexBeforePer100).toBeCloseTo((44 + 137 + 12) / 120 * 100, 8)
    expect(cycle.manualEffortIndexAfterPer100).toBeCloseTo(22.5, 8)
    expect(cycle.manualEffortIndexAfterPer100).toBeLessThan(cycle.manualEffortIndexBeforePer100)
  })

  it('produces positive annualized enterprise savings', () => {
    expect(cycle.annualizedEnterpriseSavingsUsd).toBeGreaterThan(0)
    expect(Number.isFinite(cycle.annualizedEnterpriseSavingsUsd)).toBe(true)
  })

  it('is fully deterministic across repeated cycles', () => {
    const secondCycle = runClosedLoopOptimizationCycle(
      DEFAULT_ROUTING_POLICY,
      CONTEXT_RULES,
      SQL_BENCHMARK_CASES,
      generateTelemetrySessions()
    )
    expect(secondCycle).toEqual(cycle)
  })

  it('applies the autopilot transform to a rule id set (add patches, strip bloat)', () => {
    const transformed = applyAutopilotToRuleIds(BASELINE_RULE_IDS, CONTEXT_RULES)
    expect(transformed).toEqual(CLOSED_LOOP_RULE_IDS)
    const alreadyOptimized = applyAutopilotToRuleIds(CLOSED_LOOP_RULE_IDS, CONTEXT_RULES)
    expect(alreadyOptimized).toEqual(CLOSED_LOOP_RULE_IDS)
  })
})

describe('Warehouse SQL & Telemetry Schema Contracts', () => {
  it('uses realistic SQL constructs across the 20 benchmark cases', () => {
    expect(SQL_BENCHMARK_CASES.length).toBe(20)
    const combined = SQL_BENCHMARK_CASES.map(
      (benchmark) => `${benchmark.uncontextualizedSql}\n${benchmark.contextualizedSql}`
    )
    for (const sql of combined) {
      expect(
        /WHERE|GROUP BY|JOIN|WITH|QUALIFY/.test(sql)
      ).toBe(true)
    }
    const whereCount = combined.filter((sql) => sql.includes('WHERE')).length
    const groupByCount = combined.filter((sql) => sql.includes('GROUP BY')).length
    const joinCount = combined.filter((sql) => sql.includes('JOIN')).length
    const cteCount = combined.filter((sql) => sql.includes('WITH ')).length
    const qualifyCount = combined.filter((sql) => sql.includes('QUALIFY')).length
    expect(whereCount).toBeGreaterThanOrEqual(18)
    expect(groupByCount).toBeGreaterThanOrEqual(5)
    expect(joinCount).toBeGreaterThanOrEqual(6)
    expect(cteCount).toBeGreaterThanOrEqual(4)
    expect(qualifyCount).toBeGreaterThanOrEqual(1)
  })

  it('keeps benchmark latency and cost economics within production-like ranges', () => {
    for (const benchmark of SQL_BENCHMARK_CASES) {
      expect(benchmark.avgExecutionLatencyMs).toBeGreaterThan(100)
      expect(benchmark.avgExecutionLatencyMs).toBeLessThan(5_000)
      expect(benchmark.tokenCostPerRunUsd).toBeGreaterThan(0.01)
      expect(benchmark.tokenCostPerRunUsd).toBeLessThan(0.5)
      expect(benchmark.naturalLanguageQuestion.length).toBeGreaterThan(15)
      expect(benchmark.ambiguityTrap.length).toBeGreaterThan(20)
      expect(benchmark.targetTables.length).toBeGreaterThan(0)
    }
  })

  it('ships complete edit-diff snippet pairs for every failure category', () => {
    const categories = Object.keys(EDIT_DIFF_SNIPPET_LIBRARY)
    expect(categories).toHaveLength(5)
    for (const category of categories) {
      const library = EDIT_DIFF_SNIPPET_LIBRARY[category as keyof typeof EDIT_DIFF_SNIPPET_LIBRARY]
      expect(library.length).toBeGreaterThanOrEqual(2)
      for (const pair of library) {
        expect(pair.agentOutput.length).toBeGreaterThan(20)
        expect(pair.userCorrection.length).toBeGreaterThan(20)
      }
    }
  })

  it('keeps every session cost identity and feedback channel consistent', () => {
    const seenIds = new Set<string>()
    for (const session of TELEMETRY_SESSIONS as UserInteractionTelemetry[]) {
      expect(seenIds.has(session.sessionId)).toBe(false)
      seenIds.add(session.sessionId)
      expect(session.timestampIso).toMatch(/^2026-09-\d{2}T\d{2}:00:00\.000Z$/)
      expect(session.initialPromptTokens).toBeGreaterThan(0)
      expect(session.completionTokens).toBeGreaterThan(0)
      if (session.rootFailureCategory === 'none') {
        expect(session.userEditedDiffSnippet).toBeUndefined()
      } else {
        expect(session.userEditedDiffSnippet).toBeDefined()
      }
    }
    expect(seenIds.size).toBe(120)
  })
})

describe('Living Loop Diagnostics & Rule Survival', () => {
  it('seeds reward-not-pain signals: 1.0 accepted, 1.0 - editDistance partial, 0.0 rejected', () => {
    for (const session of TELEMETRY_SESSIONS) {
      const reward = session.rewardCompletenessScore
      expect(reward).toBeDefined()
      if (reward === undefined) continue
      expect(reward).toBeGreaterThanOrEqual(0)
      expect(reward).toBeLessThanOrEqual(1)
      if (session.userOutcome === 'accepted_as_is') expect(reward).toBe(1.0)
      if (session.userOutcome === 'rejected_abandoned') expect(reward).toBe(0.0)
      if (session.userOutcome === 'accepted_after_edit') {
        expect(reward).toBeCloseTo(Math.max(0, 1 - session.editDistanceRatio), 3)
      }
    }
    const signals = computeLivingSignalSummary(TELEMETRY_SESSIONS)
    expect(signals.avgRewardCompletenessScore).toBeGreaterThan(0.5)
    expect(signals.avgRewardCompletenessScore).toBeLessThan(1)
    expect(signals.avgSignalCaptureLatencySec).toBeGreaterThan(0)
    expect(signals.zeroRewardTrajectoryCount).toBe(26)
  })

  it('captures 12 hand-typed override instructions and a positive latency for every session', () => {
    const overrideSessions = TELEMETRY_SESSIONS.filter(
      (session) => session.handTypedOverrideInstruction !== undefined
    )
    expect(overrideSessions).toHaveLength(12)
    for (const session of TELEMETRY_SESSIONS) {
      expect(session.signalCaptureLatencySec).toBeDefined()
      expect(session.signalCaptureLatencySec ?? 0).toBeGreaterThan(0)
    }
  })

  it('computes the Manual Effort Index as edits + regenerations + overrides per 100 sessions', () => {
    expect(computeManualEffortIndex(TELEMETRY_SESSIONS)).toBeCloseTo(
      (44 + 137 + 12) / 120 * 100,
      8
    )
    expect(computeManualEffortIndex([])).toBe(0)
    const remediated = simulateTelemetryAfterAutopilot(TELEMETRY_SESSIONS, CLOSED_LOOP_RULE_IDS)
    expect(computeManualEffortIndex(remediated)).toBeCloseTo((8 + 19 + 0) / 120 * 100, 8)
    const remediatedSignals = computeLivingSignalSummary(remediated)
    expect(remediatedSignals.handTypedOverrideSessions).toBe(0)
    expect(remediatedSignals.avgRewardCompletenessScore).toBeGreaterThan(
      computeLivingSignalSummary(TELEMETRY_SESSIONS).avgRewardCompletenessScore
    )
  })

  it('promotes only hand-typed patterns crossing the 10-repetition trigger', () => {
    expect(REPETITION_TRIGGER_THRESHOLD).toBe(10)
    expect(MANUAL_INSTRUCTION_EVENTS).toHaveLength(52)
    const candidates = classifyRepetitionTriggers(
      MANUAL_INSTRUCTION_EVENTS,
      CONTEXT_RULES,
      SQL_BENCHMARK_CASES
    )
    expect(candidates).toHaveLength(4)
    for (const candidate of candidates) {
      expect(candidate.occurrenceCount).toBeGreaterThanOrEqual(REPETITION_TRIGGER_THRESHOLD)
    }
    // The 6-occurrence pattern below the trigger never promotes.
    expect(
      candidates.some((candidate) =>
        candidate.repeatedInstructionText.includes('markdown headers')
      )
    ).toBe(false)
    // Deterministic replay produces identical candidates.
    expect(
      classifyRepetitionTriggers(MANUAL_INSTRUCTION_EVENTS, CONTEXT_RULES, SQL_BENCHMARK_CASES)
    ).toEqual(candidates)
  })

  it('routes single-user habits to profile memory and 3-plus-user patterns to org context', () => {
    expect(SYSTEMIC_FLAW_MIN_UNIQUE_USERS).toBe(3)
    const candidates = classifyRepetitionTriggers(
      MANUAL_INSTRUCTION_EVENTS,
      CONTEXT_RULES,
      SQL_BENCHMARK_CASES
    )
    const personal = candidates.filter(
      (candidate) => candidate.classification === 'personal_user_preference'
    )
    const systemic = candidates.filter(
      (candidate) => candidate.classification === 'systemic_org_flaw'
    )
    expect(personal).toHaveLength(2)
    expect(systemic).toHaveLength(2)
    for (const candidate of personal) {
      expect(candidate.uniqueUsersCount).toBeLessThan(SYSTEMIC_FLAW_MIN_UNIQUE_USERS)
      expect(candidate.recommendedTargetScope).toBe('user_profile_memory')
    }
    for (const candidate of systemic) {
      expect(candidate.uniqueUsersCount).toBeGreaterThanOrEqual(SYSTEMIC_FLAW_MIN_UNIQUE_USERS)
      expect(candidate.recommendedTargetScope).toBe('global_org_context')
    }
    const softDeletedPattern = candidates.find((candidate) =>
      normalizeInstructionText(candidate.repeatedInstructionText).includes('soft-deleted')
    )
    expect(softDeletedPattern).toBeDefined()
    if (softDeletedPattern !== undefined) {
      expect(softDeletedPattern.uniqueUsersCount).toBe(4)
      expect(softDeletedPattern.occurrenceCount).toBe(13)
      expect(softDeletedPattern.classification).toBe('systemic_org_flaw')
    }
  })

  it('passes cause-level patches only when remediation breadth prevents at least 2 correction patterns', () => {
    expect(CAUSE_LEVEL_MIN_BREADTH).toBe(2)
    for (const rule of CONTEXT_RULES.filter((r) => r.recommendedAction === 'auto_inject_patch')) {
      const diagnosis = evaluateSymptomVsCause(rule, SQL_BENCHMARK_CASES)
      expect(diagnosis.passesCauseTest).toBe(true)
      expect(diagnosis.diagnosisLevel).toBe('cause_level')
      expect(diagnosis.remediationBreadthCount).toBeGreaterThanOrEqual(2)
      // The live breadth recomputation matches the seeded structural metadata.
      expect(diagnosis.remediationBreadthCount).toBe(
        computeRemediationBreadthCount(rule, SQL_BENCHMARK_CASES)
      )
    }
    const mrrStatusRule = CONTEXT_RULES.find(
      (rule) => rule.ruleId === 'ctx_core_active_subscription_status'
    )
    expect(mrrStatusRule).toBeDefined()
    if (mrrStatusRule !== undefined) {
      const diagnosis = evaluateSymptomVsCause(mrrStatusRule, SQL_BENCHMARK_CASES)
      expect(diagnosis.remediationBreadthCount).toBe(1)
      expect(diagnosis.diagnosisLevel).toBe('symptom_level')
      expect(diagnosis.passesCauseTest).toBe(false)
    }
  })

  it('keeps multi-function and guardrail rules while scoping or pruning the rest (dual survival)', () => {
    const verdictById = new Map(
      CONTEXT_RULES.map((rule) => [
        rule.ruleId,
        evaluateDualRuleSurvival(rule, SQL_BENCHMARK_CASES).verdict
      ])
    )
    expect(verdictById.get('ctx_core_soft_delete')).toBe('retain_core')
    expect(verdictById.get('ctx_core_settled_ledger')).toBe('retain_core')
    expect(verdictById.get('ctx_core_cents_to_usd')).toBe('retain_core')
    expect(verdictById.get('ctx_patch_fx_effective_date_join')).toBe('retain_core')
    // Domain correctness guardrail exception protects the fiscal-year fact.
    expect(verdictById.get('ctx_patch_fiscal_calendar')).toBe('retain_core')
    // Single-purpose, empirically useful rules scope down instead of globalizing.
    expect(verdictById.get('ctx_core_active_subscription_status')).toBe('scoped_guardrail')
    expect(verdictById.get('ctx_core_utc_timezone')).toBe('scoped_guardrail')
    expect(verdictById.get('ctx_patch_sandbox_org_exclusion')).toBe('scoped_guardrail')
    // Zero-gain bloat fails both checks and is pruned.
    expect(verdictById.get('ctx_bloat_legacy_style_guide')).toBe('prune_bloat')
    expect(verdictById.get('ctx_bloat_governance_boilerplate')).toBe('prune_bloat')

    // A structurally broad but empirically dormant synthetic rule routes to audit_dormant.
    const syntheticDormant = {
      ...CONTEXT_RULES[0],
      ruleId: 'ctx_synthetic_dormant',
      isMultiFunctionRule: true,
      protectsCoreCorrectness: false,
      marginalAccuracyGainPct: 0,
      efficiencyScorePer100Tokens: 0
    }
    const dormantVerdict = evaluateDualRuleSurvival(syntheticDormant, SQL_BENCHMARK_CASES)
    expect(dormantVerdict.verdict).toBe('audit_dormant')
  })
})
