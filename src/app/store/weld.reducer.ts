import { createReducer, on } from '@ngrx/store'
import type {
  AuditEvent, CapacityGap, DailyCapacity, InspectionPlan, SamplePick,
  SamplingGroup, SampleTier, TierConflict, TierSnapshot, Weld,
} from '../types'
import { addDays, groupIdOf, recomputeSampling, type SamplingEvent } from '../domain/sampling'
import { TierConcurrencyBoard } from '../domain/tier-sync'
import * as A from './weld.actions'

export interface WeldState {
  welds: Weld[]
  plans: InspectionPlan[]
  selectedId: string
  statusFilter: string
  locked: boolean
  version: number
  audit: AuditEvent[]
  groups: SamplingGroup[]
  picks: SamplePick[]
  gaps: CapacityGap[]
  capacities: DailyCapacity[]
  snapshots: TierSnapshot[]
  conflicts: TierConflict[]
  tierOverrides: Record<string, { tier: SampleTier; reason: string }>
  tierBoard: TierConcurrencyBoard
  lastEvents: SamplingEvent[]
}

const START_DATE = '2026-10-05'
const INSPECTORS = ['陈锋', '赵岚']
const INSTRUMENTS = ['UT仪-A1', 'UT仪-A2']
const INITIAL_CAPACITIES: DailyCapacity[] = [
  { date: '2026-10-05', inspectorCapacity: 1, instrumentCapacity: 1 },
  { date: '2026-10-06', inspectorCapacity: 1, instrumentCapacity: 1 },
]

const seedAudit: AuditEvent[] = [
  { id: 'AE-1', time: '16:38', actor: '赵岚', action: '提交复检', target: 'W-104', detail: '返修后 UT 复检合格，等待审核签字' },
  { id: 'AE-2', time: '15:12', actor: '陈锋', action: '录入缺陷', target: 'W-107', detail: '翼缘板端部夹渣，长度 12mm，Ⅱ级' },
  { id: 'AE-3', time: '14:20', actor: '系统', action: '资质预警', target: 'W-109', detail: '焊工证书 2026-10-01 到期，不得列入后续检测计划' },
]

export const initialState: WeldState = {
  welds: [], plans: [], selectedId: '', statusFilter: '全部', locked: false, version: 12,
  audit: seedAudit, groups: [], picks: [], gaps: [], capacities: INITIAL_CAPACITIES,
  snapshots: [], conflicts: [], tierOverrides: {}, tierBoard: new TierConcurrencyBoard(), lastEvents: [],
}

/* ------------------------------ 工具 ------------------------------ */

const auditRow = (action: string, target: string, detail: string, actor = '系统'): AuditEvent => ({
  id: `AE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
  actor, action, target, detail,
})

const eventsToAudit = (events: SamplingEvent[]) => events.map((e) => auditRow(e.action, e.target, e.detail))

const runRecompute = (
  state: WeldState,
  welds: Weld[],
  tierOverrides: Record<string, { tier: SampleTier; reason: string }>,
  manual: AuditEvent[] = [],
): WeldState => {
  const result = recomputeSampling(
    {
      welds,
      plans: state.plans.map((p) => ({ ...p, weldIds: [...p.weldIds] })),
      groups: state.groups.map((g) => ({ ...g, weldIds: [...g.weldIds] })),
      picks: state.picks.map((p) => ({ ...p })),
      capacities: state.capacities,
      gaps: state.gaps.map((g) => ({ ...g })),
      tierOverrides,
    },
    { initial: false, startDate: START_DATE, inspectors: INSPECTORS, instruments: INSTRUMENTS },
  )
  return {
    ...state,
    welds,
    plans: result.plans,
    groups: result.groups,
    picks: result.picks,
    gaps: result.gaps,
    tierOverrides,
    lastEvents: result.events,
    version: state.version + 1,
    audit: [...manual, ...eventsToAudit(result.events), ...state.audit],
  }
}

/** 首载：先试算分组，再为存量计划补样本，然后正式重算（执行中/已出报告留在原批次） */
function bootstrap(welds: Weld[], plans: InspectionPlan[]) {
  const options = { initial: true as const, startDate: START_DATE, inspectors: INSPECTORS, instruments: INSTRUMENTS }
  const first = recomputeSampling(
    { welds, plans: plans.map((p) => ({ ...p, weldIds: [...p.weldIds] })), groups: [], picks: [], capacities: INITIAL_CAPACITIES, gaps: [] },
    options,
  )
  const seeded: SamplePick[] = []
  for (const plan of plans) {
    for (const weldId of plan.weldIds) {
      const weld = welds.find((w) => w.id === weldId)
      const group = weld && first.groups.find((g) => g.id === groupIdOf(weld.drawing, weld.joint))
      if (!weld || !group) continue
      seeded.push({
        id: `SP-SEED-${plan.id}-${weldId}`, weldId, groupId: group.id, tier: group.tier,
        batchNo: `${group.id}#B0`, revision: group.revision,
        state: plan.state === '已完成' ? '已出报告' : plan.state === '执行中' ? '执行中' : '已排程',
        adopted: true, planId: plan.id, scheduledDate: plan.date,
        inspector: plan.inspector, instrument: 'UT仪-A1',
      })
    }
  }
  const result = recomputeSampling(
    {
      welds, plans: plans.map((p) => ({ ...p, weldIds: [...p.weldIds] })),
      groups: first.groups.map((g) => ({ ...g, weldIds: [...g.weldIds] })),
      picks: seeded, capacities: INITIAL_CAPACITIES, gaps: [],
    },
    options,
  )
  const snapshots: TierSnapshot[] = result.groups.map((g) => ({
    id: `TS-${g.id}`, groupId: g.id, revision: g.revision, tier: g.tier,
    reason: g.reason, time: g.revisionTime, actor: '系统初始化',
  }))
  return { ...result, snapshots }
}

/** 人工修改提案：审核确认前不递增修订号（并发修改因此撞在同一修订上）；层级变化时记录原层级 */
const withProposal = (group: SamplingGroup, tier: SampleTier, reason: string, time: string): SamplingGroup => ({
  ...group,
  tier,
  reason,
  status: '待确认',
  revisionTime: time,
  previousTier: group.status === '有效' ? group.tier : group.previousTier,
})

const timeNow = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

/* ------------------------------ Reducer ------------------------------ */

export const weldReducer = createReducer(
  initialState,

  on(A.loadWeldsSuccess, (state, { welds, plans }) => {
    const booted = bootstrap(welds, plans)
    return {
      ...state,
      welds, plans: booted.plans, groups: booted.groups, picks: booted.picks,
      gaps: booted.gaps, capacities: INITIAL_CAPACITIES, snapshots: booted.snapshots,
      selectedId: state.selectedId || welds[0]?.id || '',
      lastEvents: booted.events,
      audit: [...eventsToAudit(booted.events), ...state.audit],
    }
  }),

  on(A.selectWeld, (state, { id }) => ({ ...state, selectedId: id })),
  on(A.filterStatus, (state, { status }) => ({ ...state, statusFilter: status })),

  on(A.advanceWeld, (state, { id, status }) => ({
    ...state, version: state.version + 1,
    welds: state.welds.map((w) => (w.id === id ? { ...w, status } : w)),
    audit: [auditRow('状态流转', id, `状态变更为 ${status}`, '当前审核人'), ...state.audit],
  })),

  on(A.createPlan, (state, { plan }) => ({ ...state, plans: [plan, ...state.plans], version: state.version + 1 })),
  on(A.lockBaseline, (state) => ({
    ...state, locked: true,
    audit: [auditRow('签字锁定', '检测批次', '焊工资质、检测比例、分级抽检与返修闭环已确认', '质量负责人'), ...state.audit],
  })),

  /* 缺陷等级一变 → 按图纸+接头类型重算组内层级；清除该组人工覆盖，回到数据驱动 */
  on(A.recordDefect, (state, { weldId, defectType, level, length, method, report }) => {
    const weld = state.welds.find((w) => w.id === weldId)
    if (!weld) return state
    const defect = {
      id: `D-${Date.now().toString().slice(-4)}`, position: 42, type: defectType, length, level, method, report,
    }
    const welds = state.welds.map((w) => (w.id === weldId
      ? { ...w, defects: [...w.defects, defect], status: '返修中' as const }
      : w))
    const gid = groupIdOf(weld.drawing, weld.joint)
    const overrides = { ...state.tierOverrides }
    delete overrides[gid]
    return runRecompute(state, welds, overrides, [
      auditRow('录入缺陷', weldId, `${defectType} ${level}（${length}mm，${method}，报告 ${report}），触发 ${gid} 组层级重算`, '现场检验员'),
    ])
  }),

  /* 返修次数一变 → 重算 */
  on(A.registerRepair, (state, { weldId, note }) => {
    const weld = state.welds.find((w) => w.id === weldId)
    if (!weld) return state
    const welds = state.welds.map((w) => (w.id === weldId
      ? { ...w, repairs: w.repairs + 1, status: '返修中' as const }
      : w))
    const gid = groupIdOf(weld.drawing, weld.joint)
    const overrides = { ...state.tierOverrides }
    delete overrides[gid]
    return runRecompute(state, welds, overrides, [
      auditRow('登记返修', weldId, `返修次数 ${weld.repairs} → ${weld.repairs + 1}${note ? `；${note}` : ''}，触发 ${gid} 组层级重算`, '现场检验员'),
    ])
  }),

  on(A.startPlan, (state, { planId }) => {
    const plans = state.plans.map((p) => (p.id === planId && p.state === '待执行' ? { ...p, state: '执行中' as const } : p))
    const picks = state.picks.map((p) => (p.planId === planId && p.state === '已排程' ? { ...p, state: '执行中' as const } : p))
    return { ...state, plans, picks, audit: [auditRow('开始执行计划', planId, '计划进入执行中，组内样本留在原批次'), ...state.audit] }
  }),

  /* 已出报告的留在原批次 */
  on(A.completePlan, (state, { planId }) => {
    const plans = state.plans.map((p) => (p.id === planId && p.state === '执行中' ? { ...p, state: '已完成' as const } : p))
    const picks = state.picks.map((p) => (p.planId === planId && p.state === '执行中' ? { ...p, state: '已出报告' as const } : p))
    return { ...state, plans, picks, audit: [auditRow('出具报告', planId, '检测报告已出具，样本锁定在原批次，后续层级变更不追溯'), ...state.audit] }
  }),

  /* 两个人同时修改同一份层级：先到结果保留，后到内容作为差异待处理 */
  on(A.proposeTier, (state, { groupId, tier, reason, actor }) => {
    const group = state.groups.find((g) => g.id === groupId)
    if (!group) return state
    const outcome = state.tierBoard.submit(groupId, group.revision, { actor, tier, reason })
    if (!outcome.accepted && outcome.conflict) {
      return {
        ...state,
        conflicts: [...state.conflicts, outcome.conflict],
        audit: [auditRow('层级修改冲突', groupId,
          `${actor} 提交「${tier}」晚于 ${outcome.conflict.firstActor} 已保留的「${outcome.conflict.firstTier}」，后到内容登记为差异 ${outcome.conflict.id} 待处理`, actor),
        ...state.audit],
      }
    }
    return {
      ...state,
      groups: state.groups.map((g) => (g.id === groupId ? withProposal(g, tier, reason, timeNow()) : g)),
      audit: [auditRow('提交层级修改', groupId, `${actor} 将层级调整为 ${tier}（待审核快照确认）：${reason}`, actor), ...state.audit],
    }
  }),

  on(A.tierConflictRaised, (state, { conflict }) => ({ ...state, conflicts: [...state.conflicts, conflict] })),

  /* 审核快照确认；生成可回滚的“上次确认层级”；确认即生效并按新层级失效/保留/补抽 */
  on(A.confirmTier, (state, { groupId, actor }) => {
    const group = state.groups.find((g) => g.id === groupId)
    const snap = state.snapshots.find((s) => s.groupId === groupId)
    if (!group || group.status !== '待确认' || !snap) return state
    const time = timeNow()
    const changed = group.tier !== snap.tier
    const confirmed: SamplingGroup = {
      ...group,
      status: '有效',
      revision: changed ? group.revision + 1 : group.revision,
      revisionTime: time,
      batchSeq: changed ? group.batchSeq + 1 : group.batchSeq,
    }
    const groups = state.groups.map((g) => (g.id === groupId ? confirmed : g))
    const overrides = { ...state.tierOverrides, [groupId]: { tier: group.tier, reason: group.reason } }
    const snapshot: TierSnapshot = {
      id: `TS-${groupId}`, groupId, revision: confirmed.revision, tier: group.tier,
      reason: group.reason, time, actor,
    }
    state.tierBoard.release(groupId, group.revision)
    const base: WeldState = {
      ...state,
      groups,
      tierOverrides: overrides,
      snapshots: [...state.snapshots.filter((s) => s.groupId !== groupId), snapshot],
    }
    const manual = [auditRow('快照确认层级', groupId,
      `rev ${snap.revision} → ${confirmed.revision} · ${snap.tier} → ${group.tier}，已确认并生成审核快照，未开始计划失效后补入新样本`, actor)]
    return changed
      ? runRecompute(base, state.welds, overrides, manual)
      : { ...base, version: state.version + 1, audit: [manual[0], ...state.audit] }
  }),

  /* 合并差异：采用后到者内容，重新挂为待确认修订 */
  on(A.adoptConflictTier, (state, { conflict }) => {
    const resolved = state.tierBoard.resolveConflict(conflict.id, 'merge')
    if (!resolved?.adopt) return state
    const groups = state.groups.map((g) => (g.id === conflict.groupId
      ? withProposal(g, resolved.adopt!.tier, resolved.adopt!.reason, timeNow())
      : g))
    return {
      ...state, groups,
      conflicts: state.conflicts.map((c) => (c.id === conflict.id ? { ...c, state: '已合并' as const } : c)),
      audit: [auditRow('合并层级差异', conflict.groupId,
        `差异 ${conflict.id}：采用后到者 ${conflict.laterActor} 的「${conflict.laterTier}」，重新挂为待确认修订`, '质量负责人'),
      ...state.audit],
    }
  }),

  /* 忽略差异：先到结果保留 */
  on(A.dismissConflict, (state, { conflictId }) => {
    const resolved = state.tierBoard.resolveConflict(conflictId, 'ignore')
    if (!resolved) return state
    return {
      ...state,
      conflicts: state.conflicts.map((c) => (c.id === conflictId ? { ...c, state: '已忽略' as const } : c)),
      audit: [auditRow('忽略层级差异', resolved.conflict.groupId,
        `差异 ${conflictId}：保留先到者 ${resolved.conflict.firstActor} 的「${resolved.conflict.firstTier}」`, '质量负责人'),
      ...state.audit],
    }
  }),

  /* 调整失败 → 恢复上次确认的层级并继续；已采用样本不重复抽取（重算时全部保留） */
  on(A.rollbackTier, (state, { groupId }) => {
    const snap = state.snapshots.find((s) => s.groupId === groupId)
    if (!snap) return state
    const groups = state.groups.map((g) => (g.id === groupId
      ? { ...g, tier: snap.tier, reason: `${snap.reason}（已恢复上次确认层级 rev ${snap.revision}）`, status: '有效' as const, previousTier: g.tier }
      : g))
    const overrides = { ...state.tierOverrides, [groupId]: { tier: snap.tier, reason: snap.reason } }
    const current = state.groups.find((g) => g.id === groupId)
    if (current) state.tierBoard.release(groupId, current.revision)
    const result = recomputeSampling(
      {
        welds: state.welds,
        plans: state.plans.map((p) => ({ ...p, weldIds: [...p.weldIds] })),
        groups: groups.map((g) => ({ ...g, weldIds: [...g.weldIds] })),
        picks: state.picks.map((p) => ({ ...p })),
        capacities: state.capacities,
        gaps: state.gaps.map((g) => ({ ...g })),
        tierOverrides: overrides,
      },
      { initial: false, startDate: START_DATE, inspectors: INSPECTORS, instruments: INSTRUMENTS },
    )
    return {
      ...state,
      groups: result.groups, plans: result.plans, picks: result.picks, gaps: result.gaps, tierOverrides: overrides,
      lastEvents: result.events, version: state.version + 1,
      audit: [
        auditRow('恢复上次确认层级', groupId, `调整失败后回滚至 rev ${snap.revision} · ${snap.tier}，已采用样本不重复抽取，继续后续抽检`),
        ...eventsToAudit(result.events), ...state.audit,
      ],
    }
  }),

  /* 容量扩充：顺延样本重新排队 */
  on(A.extendCapacity, (state) => {
    const last = state.capacities[state.capacities.length - 1]?.date ?? START_DATE
    const dates = new Set(state.capacities.map((c) => c.date))
    const added: DailyCapacity[] = []
    for (let i = 1; i <= 7; i++) {
      const date = addDays(last, i)
      if (!dates.has(date)) added.push({ date, inspectorCapacity: 1, instrumentCapacity: 1 })
    }
    const capacities = [...state.capacities, ...added]
    const result = recomputeSampling(
      {
        welds: state.welds,
        plans: state.plans.map((p) => ({ ...p, weldIds: [...p.weldIds] })),
        groups: state.groups.map((g) => ({ ...g, weldIds: [...g.weldIds] })),
        picks: state.picks.map((p) => ({ ...p })),
        capacities, gaps: state.gaps.map((g) => ({ ...g })),
        tierOverrides: state.tierOverrides,
      },
      { initial: false, startDate: START_DATE, inspectors: INSPECTORS, instruments: INSTRUMENTS },
    )
    return {
      ...state, capacities, plans: result.plans, groups: result.groups, picks: result.picks,
      gaps: result.gaps, lastEvents: result.events, version: state.version + 1,
      audit: [
        auditRow('扩充检测容量', '排程窗口', `追加 ${added.map((c) => c.date).join('、')} 检验员/超声仪容量，顺延样本重新排队`),
        ...eventsToAudit(result.events), ...state.audit,
      ],
    }
  }),
)
