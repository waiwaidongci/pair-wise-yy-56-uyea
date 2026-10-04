import type {
  CapacityGap, DailyCapacity, DefectLevel, InspectionPlan, SamplePick, SamplingGroup, SampleTier,
  TierPolicy, Weld, WeldStatus,
} from '../types'

/* ============================== 策略 ============================== */

/** 分级抽检层级策略：层级随组内最差缺陷等级与返修次数变化 */
export const TIER_POLICIES: Record<SampleTier, TierPolicy> = {
  放宽: { tier: '放宽', ratio: 10, trigger: '无在册缺陷记录' },
  正常: { tier: '正常', ratio: 20, trigger: '存在 Ⅱ 级缺陷或 1 次返修' },
  加严: { tier: '加严', ratio: 100, trigger: '出现 Ⅲ/Ⅳ 级缺陷，或返修达 2 次' },
}

export const TIER_ORDER: SampleTier[] = ['放宽', '正常', '加严']
const LEVEL_RANK: Record<DefectLevel, number> = { 'Ⅰ级': 1, 'Ⅱ级': 2, 'Ⅲ级': 3, 'Ⅳ级': 4 }
const INSPECTABLE: WeldStatus[] = ['待检测', '返修中', '待复检']

let seq = 0
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`

export const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

function worstLevel(welds: Weld[]): DefectLevel | undefined {
  let rank = 0
  let result: DefectLevel | undefined
  for (const w of welds) for (const d of w.defects) {
    if (LEVEL_RANK[d.level] > rank) { rank = LEVEL_RANK[d.level]; result = d.level }
  }
  return result
}

/** 按图纸 + 接头类型计算组内应执行的层级与依据 */
export function deriveTier(welds: Weld[]): { tier: SampleTier; reason: string } {
  const level = worstLevel(welds)
  const maxRepairs = welds.reduce((m, w) => Math.max(m, w.repairs), 0)
  if (level === 'Ⅳ级') return { tier: '加严', reason: `出现 Ⅳ 级缺陷（${TIER_POLICIES.加严.ratio}% 抽检）` }
  if (level === 'Ⅲ级' || maxRepairs >= 2) return { tier: '加严', reason: `${level === 'Ⅲ级' ? '出现 Ⅲ 级缺陷' : '返修达 2 次'}，组内加严 ${TIER_POLICIES.加严.ratio}%` }
  if (level === 'Ⅱ级' || maxRepairs === 1) return { tier: '正常', reason: `${level === 'Ⅱ级' ? '存在 Ⅱ 级缺陷' : '发生 1 次返修'}，正常抽检 ${TIER_POLICIES.正常.ratio}%` }
  return { tier: '放宽', reason: `无在册缺陷，放宽抽检 ${TIER_POLICIES.放宽.ratio}%` }
}

export const groupIdOf = (drawing: string, joint: string) => `${drawing}#${joint}`

/* ============================== 输入输出 ============================== */

export interface SamplingWorld {
  welds: Weld[]
  plans: InspectionPlan[]
  groups: SamplingGroup[]
  picks: SamplePick[]
  capacities: DailyCapacity[]
  gaps: CapacityGap[]
  /** 人工确认过的层级（审核快照效力）；数据重算时可被清除 */
  tierOverrides?: Record<string, { tier: SampleTier; reason: string }>
}

export interface SamplingEvent {
  action: string
  target: string
  detail: string
}

export interface RecomputeResult {
  groups: SamplingGroup[]
  picks: SamplePick[]
  plans: InspectionPlan[]
  gaps: CapacityGap[]
  events: SamplingEvent[]
}

export interface RecomputeOptions {
  initial?: boolean
  startDate: string
  inspectors: string[]
  instruments: string[]
}

/* ============================== 日期工具 ============================== */

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return dt.toISOString().slice(0, 10)
}

/* ============================== 重算主流程 ============================== */

/**
 * 缺陷等级或返修次数一变即重算：
 * 1) 按图纸+接头分组，按最差缺陷/返修次数推导层级（修订号 +1，待确认）；
 * 2) 未开始（待执行）计划命中旧修订即整单失效、样本回池补抽；执行中/已出报告的留在原批次；
 * 3) 已采用样本不重复抽取，按新层级比例补足新样本；
 * 4) 检验员/超声仪按日容量排程，排不进去写明缺口并顺延。
 */
export function recomputeSampling(world: SamplingWorld, opts: RecomputeOptions): RecomputeResult {
  const events: SamplingEvent[] = []
  const { welds } = world
  const { startDate } = opts
  const byId = new Map(welds.map((w) => [w.id, w]))

  /* ---------- 1. 分组与层级 ---------- */
  const groupKeys = new Map<string, Weld[]>()
  for (const w of welds) {
    const key = groupIdOf(w.drawing, w.joint)
    groupKeys.set(key, [...(groupKeys.get(key) ?? []), w])
  }
  const oldGroups = new Map(world.groups.map((g) => [g.id, g]))
  const groups: SamplingGroup[] = []
  for (const [id, members] of [...groupKeys].sort(([a], [b]) => a.localeCompare(b))) {
    const auto = deriveTier(members)
    const override = world.tierOverrides?.[id]
    const derived = override ? { tier: override.tier, reason: override.reason } : auto
    const old = oldGroups.get(id)
    if (!old) {
      groups.push({
        id, drawing: members[0].drawing, joint: members[0].joint,
        weldIds: members.map((w) => w.id).sort(),
        tier: derived.tier, reason: derived.reason,
        status: opts.initial ? '有效' : '待确认',
        revision: 1, revisionTime: nowTime(), batchSeq: 1,
      })
      if (!opts.initial) events.push({ action: '新增抽检组', target: id, detail: `初始层级 ${derived.tier}（${derived.reason}）` })
      continue
    }
    if (derived.tier === old.tier) {
      groups.push({ ...old, reason: derived.reason })
      continue
    }
    const g: SamplingGroup = {
      ...old,
      reason: derived.reason,
      revisionTime: nowTime(),
      previousTier: old.status === '有效' ? old.tier : old.previousTier,
    }
    if (old.status === '待确认') {
      g.tier = derived.tier
      g.revision = old.revision + 1
      events.push({ action: '层级再次重算', target: id, detail: `待确认的 ${old.tier} 被新数据覆盖为 ${derived.tier}（rev ${g.revision}）：${derived.reason}` })
    } else {
      g.tier = derived.tier
      g.status = '待确认'
      g.revision = old.revision + 1
      g.batchSeq = old.batchSeq + 1
      events.push({ action: '层级重算', target: id, detail: `${old.tier} → ${derived.tier}（rev ${g.revision}）：${derived.reason}` })
    }
    groups.push(g)
  }
  const groupMap = new Map(groups.map((g) => [g.id, g]))

  /* ---------- 2. 旧计划/旧样本失效判定 ---------- */
  const plans = world.plans.map((p) => ({ ...p, weldIds: [...p.weldIds] }))
  const planById = new Map(plans.map((p) => [p.id, p]))
  const picks = world.picks.map((p) => ({ ...p }))

  const invalidatePlan = (plan: InspectionPlan, revision: number) => {
    if (plan.state !== '待执行') return
    plan.state = '已失效'
    plan.invalidatedRevision = Math.max(plan.invalidatedRevision ?? 0, revision)
    events.push({ action: '计划失效', target: plan.id, detail: `组内层级变更（rev ${revision}），未开始计划 ${plan.id}（${plan.date}，${plan.weldIds.length} 条焊缝）整单失效，样本回池补抽` })
  }

  for (const pick of picks) {
    const g = groupMap.get(pick.groupId)
    if (!g || pick.state === '原批次保留') continue
    const plan = pick.planId ? planById.get(pick.planId) : undefined
    const stale = pick.revision < g.revision
    if (!stale) continue
    if (plan && plan.state === '执行中') {
      pick.state = '原批次保留'
      events.push({ action: '原批次保留', target: pick.weldId, detail: `执行中计划 ${plan.id} 已开工，样本按旧层级 ${pick.tier} 留在原批次` })
    } else if (plan && plan.state === '已完成') {
      pick.state = '原批次保留'
      events.push({ action: '原批次保留', target: pick.weldId, detail: `已出报告计划 ${plan.id} 不追溯，样本留在原批次` })
    } else {
      if (plan) invalidatePlan(plan, g.revision)
      pick.state = '已失效'
      pick.adopted = false
      pick.gap = undefined
    }
  }
  // 待执行计划一旦整单失效，单内其余未变层级样本一并回池
  for (const plan of plans) {
    if (plan.state !== '已失效') continue
    for (const pick of picks) {
      if (pick.planId === plan.id && pick.state !== '原批次保留') {
        pick.state = '已失效'
        pick.adopted = false
        pick.gap = undefined
      }
    }
  }

  /* ---------- 3. 补入新样本（已采用不重复抽取；原批次保留不重抽） ---------- */
  // 仍占用名额：有效样本（含已失效以外的全部状态）；已失效样本已回池
  const held = new Set(picks.filter((p) => p.state !== '已失效').map((p) => p.weldId))
  const newPicks: SamplePick[] = []
  for (const g of groups) {
    const members = g.weldIds.map((id) => byId.get(id)!).filter(Boolean)
    const inspectable = members.filter((w) => INSPECTABLE.includes(w.status))
    // 组内已无可抽检焊缝时不再下达样本目标
    const target = inspectable.length === 0
      ? 0
      : Math.max(1, Math.ceil((TIER_POLICIES[g.tier].ratio / 100) * inspectable.length))
    const heldCount = picks.filter((p) => p.groupId === g.id && p.state !== '已失效').length
    const need = Math.max(0, target - heldCount)
    const candidates = inspectable
      .filter((w) => !held.has(w.id))
      .sort((a, b) => a.id.localeCompare(b.id))
    const chosen = candidates.slice(0, need)
    for (const w of chosen) {
      const pick: SamplePick = {
        id: uid('SP'), weldId: w.id, groupId: g.id, tier: g.tier,
        batchNo: `${g.id}#B${g.batchSeq}`, revision: g.revision,
        state: '待排程', adopted: true,
      }
      picks.push(pick)
      newPicks.push(pick)
      held.add(w.id)
    }
    if (need > 0) {
      events.push({
        action: chosen.length ? '补入新样本' : '样本缺口',
        target: g.id,
        detail: chosen.length
          ? `${g.tier}层级目标 ${target} 个、原批次保留 ${heldCount} 个，补抽 ${chosen.length} 个：${chosen.map((w) => w.id).join('、')}`
          : `${g.tier}层级尚需 ${need} 个样本，但组内已无未采用焊缝`,
      })
    }
  }

  /* ---------- 4. 容量排程：检验员 + 超声仪按日容量 ---------- */
  const capacities = [...world.capacities].sort((a, b) => a.date.localeCompare(b.date))
  const capByDate = new Map(capacities.map((c) => [c.date, c]))
  const inspectorLoad = new Map<string, Map<string, number>>()
  const instrumentLoad = new Map<string, Map<string, number>>()
  const bump = (map: Map<string, Map<string, number>>, date: string, key: string) => {
    if (!map.has(date)) map.set(date, new Map())
    const m = map.get(date)!
    m.set(key, (m.get(key) ?? 0) + 1)
  }
  // 已占用容量（执行中/已排程且仍有效）
  for (const p of picks) {
    if (!p.scheduledDate || p.state === '已失效') continue
    if (p.inspector) bump(inspectorLoad, p.scheduledDate, p.inspector)
    if (p.instrument) bump(instrumentLoad, p.scheduledDate, p.instrument)
  }
  const pickFree = (date: string, pool: string[], capKey: 'inspectorCapacity' | 'instrumentCapacity', load: Map<string, Map<string, number>>) => {
    const cap = capByDate.get(date)
    if (!cap) return undefined
    const used = load.get(date)
    const free = pool
      .map((name) => ({ name, used: used?.get(name) ?? 0 }))
      .filter((x) => x.used < cap[capKey])
      .sort((a, b) => a.used - b.used || a.name.localeCompare(b.name))
    return free[0]?.name
  }

  const validDates = capacities.filter((c) => c.date >= startDate).map((c) => c.date)
  const lastDate = validDates[validDates.length - 1] ?? startDate
  // 新补入参与排队；上轮容量不足顺延的无计划样本参与重排；
  // 首载重算时已带排程的种子样本不重复排队。已采用样本不重复抽取。
  const newIds = new Set(newPicks.map((p) => p.id))
  const retry = picks.filter(
    (p) => p.state === '待排程' && p.planId === undefined && !newIds.has(p.id)
      && !(p.scheduledDate && opts.initial),
  )
  const queue = [...newPicks, ...retry]
  const newlyScheduled: SamplePick[] = []
  const gapIndex = new Map(world.gaps.filter((g) => !g.resolved).map((g) => [`${g.weldId}-${g.resource}`, g]))
  for (const pick of queue) {
    let assigned: { date: string; inspector: string; instrument: string } | undefined
    let lastBlock: { inspectorFree?: string; instrumentFree?: string } = {}
    for (const date of validDates) {
      const inspector = pickFree(date, opts.inspectors, 'inspectorCapacity', inspectorLoad)
      const instrument = pickFree(date, opts.instruments, 'instrumentCapacity', instrumentLoad)
      if (inspector && instrument) { assigned = { date, inspector, instrument }; break }
      lastBlock = { inspectorFree: inspector, instrumentFree: instrument }
    }
    if (assigned) {
      pick.state = '已排程'
      pick.scheduledDate = assigned.date
      pick.inspector = assigned.inspector
      pick.instrument = assigned.instrument
      pick.gap = undefined
      bump(inspectorLoad, assigned.date, assigned.inspector)
      bump(instrumentLoad, assigned.date, assigned.instrument)
      newlyScheduled.push(pick)
      for (const resource of ['检验员', '超声仪'] as const) {
        const prev = gapIndex.get(`${pick.weldId}-${resource}`)
        if (prev) { prev.resolved = true; prev.resolvedDate = assigned.date }
      }
    } else {
      // 排不进去：写明缺口并顺延到容量窗口之后
      const deferDate = addDays(lastDate, 1)
      pick.scheduledDate = deferDate
      const resources: Array<'检验员' | '超声仪'> = []
      if (!lastBlock.inspectorFree) resources.push('检验员')
      if (!lastBlock.instrumentFree) resources.push('超声仪')
      if (!resources.length) resources.push('检验员', '超声仪')
      const note = `至 ${lastDate} 容量窗口已满（${resources.join('、')}每日容量用尽），样本顺延至 ${deferDate}，需扩容量或加班`
      pick.gap = note
      for (const resource of resources) {
        const key = `${pick.weldId}-${resource}`
        if (!gapIndex.has(key)) gapIndex.set(key, {
          id: uid('GAP'), groupId: pick.groupId, weldId: pick.weldId, fromDate: lastDate,
          resource, required: 1, available: 0, note, resolved: false,
        })
      }
      events.push({ action: '容量缺口顺延', target: pick.weldId, detail: note })
    }
  }

  /* ---------- 5. 为新排程样本生成补样计划 ---------- */
  const scheduled = newlyScheduled
  const byDate = new Map<string, SamplePick[]>()
  for (const p of scheduled) {
    byDate.set(p.scheduledDate!, [...(byDate.get(p.scheduledDate!) ?? []), p])
  }
  const replacedGroups = new Set<string>()
  for (const [date, items] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    const inspectorVotes = new Map<string, number>()
    for (const p of items) inspectorVotes.set(p.inspector!, (inspectorVotes.get(p.inspector!) ?? 0) + 1)
    const inspector = [...inspectorVotes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    const groupIds = [...new Set(items.map((p) => p.groupId))]
    const plan: InspectionPlan = {
      id: uid('IP-AUTO'),
      date, method: 'UT',
      weldIds: items.map((p) => p.weldId).sort(),
      inspector, state: '待执行',
      batchNo: [...new Set(items.map((p) => p.batchNo))].join(','),
    }
    plans.push(plan)
    for (const p of items) p.planId = plan.id
    for (const gid of groupIds) replacedGroups.add(gid)
  }
  // 失效计划挂接替代计划
  for (const plan of plans) {
    if (plan.state !== '已失效' || plan.replacedBy) continue
    const replacement = plans.find((p) => p.state === '待执行' && p.id.startsWith('IP-AUTO') && p.weldIds.some((id) => plan.weldIds.includes(id)))
    if (replacement) plan.replacedBy = replacement.id
  }

  return {
    groups,
    picks: picks.filter((p) => groupMap.has(p.groupId)),
    plans,
    gaps: [...gapIndex.values()],
    events,
  }
}
