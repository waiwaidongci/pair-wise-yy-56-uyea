import { createReducer, on } from '@ngrx/store'
import type { AuditEvent, CapacityConfig, Defect, GroupStatus, InspectionPlan, QueueItem, SamplingGroup, Weld } from '../types'
import * as A from './weld.actions'
import {
  adoptDiff,
  buildGroups,
  commitLevel,
  groupIdFor,
  keepFirst,
  recalcGroup,
  restoreLevel,
  scheduleSamples,
} from '../sampling/sampling-engine'

export interface WeldState {
  welds: Weld[]
  plans: InspectionPlan[]
  groups: SamplingGroup[]
  queue: QueueItem[]
  capacity: CapacityConfig
  selectedId: string
  statusFilter: string
  locked: boolean
  version: number
  audit: AuditEvent[]
}

const audit: AuditEvent[] = [
  { id: 'AE-1', time: '16:38', actor: '赵岚', action: '提交复检', target: 'W-104', detail: '返修后 UT 复检合格，等待审核签字' },
  { id: 'AE-2', time: '15:12', actor: '陈锋', action: '录入缺陷', target: 'W-107', detail: '翼缘板端部夹渣，长度 12mm，Ⅱ级' },
  { id: 'AE-3', time: '14:20', actor: '系统', action: '资质预警', target: 'W-109', detail: '焊工证书 2026-10-01 到期，不得列入后续检测计划' },
]

export const initialState: WeldState = {
  welds: [],
  plans: [],
  groups: [],
  queue: [],
  capacity: { inspectorDaily: 6, utDaily: 4 },
  selectedId: '',
  statusFilter: '全部',
  locked: false,
  version: 12,
  audit,
}

function auditEvent(action: string, target: string, detail: string): AuditEvent {
  return {
    id: `AE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
    actor: '当前审核人',
    action,
    target,
    detail,
  }
}

function nextPlanDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** 重算单个抽检组：失效未开始计划、补入新样本、按容量排队，返回新的 groups/plans/queue/audit */
function applyRecalc(
  state: WeldState,
  groupId: string,
): { groups: SamplingGroup[]; plans: InspectionPlan[]; queue: QueueItem[]; audit: AuditEvent[] } {
  const group = state.groups.find((g) => g.id === groupId)
  if (!group) return { groups: state.groups, plans: state.plans, queue: state.queue, audit: state.audit }
  const result = recalcGroup(group, state.welds, state.plans)
  let plans = state.plans.map((p) =>
    result.invalidatedPlanIds.includes(p.id) ? { ...p, state: '已失效' as const } : p,
  )
  const newPlan: InspectionPlan = {
    id: `IP-${Date.now().toString().slice(-8)}`,
    date: nextPlanDate(),
    method: result.method,
    weldIds: result.sampleIds,
    inspector: '陈锋',
    state: '待执行',
  }
  plans = [newPlan, ...plans]
  const sched = scheduleSamples(result.group, state.capacity, newPlan.date, result.method)
  const gapNote = sched.gaps.length ? sched.gaps.join('；') : undefined
  const updatedGroup: SamplingGroup = { ...result.group, gapNote }
  const queue = [...sched.items, ...state.queue.filter((q) => q.groupId !== groupId)]
  const events = [
    auditEvent(
      '重算层级',
      groupId,
      `缺陷/返修变化触发重算：${result.previousLevel} → ${result.group.level}（比例 ${result.ratio}%），失效旧计划 ${result.invalidatedPlanIds.join('、') || '无'}，补样 ${result.sampleIds.length} 条，顺延 ${sched.postponed} 条`,
    ),
    ...state.audit,
  ]
  return {
    groups: state.groups.map((g) => (g.id === groupId ? updatedGroup : g)),
    plans,
    queue,
    audit: events,
  }
}

export const weldReducer = createReducer(
  initialState,
  on(A.loadWeldsSuccess, (state, { welds, plans }) => {
    let groups = buildGroups(welds, plans)
    groups = groups.map((g) => {
      const stale = plans.filter((p) => p.state === '待执行' && p.weldIds.some((id) => g.weldIds.includes(id)))
      if (stale.length && g.level !== '正常') {
        return {
          ...g,
          status: '待确认' as GroupStatus,
          gapNote: `存在未开始计划 ${stale.map((p) => p.id).join('、')} 与当前层级 ${g.level} 不符，需重算补样`,
        }
      }
      return g
    })
    return {
      ...state,
      welds,
      plans,
      groups,
      selectedId: state.selectedId || welds[0]?.id || '',
    }
  }),
  on(A.selectWeld, (state, { id }) => ({ ...state, selectedId: id })),
  on(A.filterStatus, (state, { status }) => ({ ...state, statusFilter: status })),
  on(A.advanceWeld, (state, { id, status }) => ({
    ...state,
    version: state.version + 1,
    welds: state.welds.map((weld) => (weld.id === id ? { ...weld, status } : weld)),
    audit: [auditEvent('状态流转', id, `状态变更为 ${status}`), ...state.audit],
  })),
  on(A.createPlan, (state, { plan }) => ({ ...state, plans: [plan, ...state.plans], version: state.version + 1 })),
  on(A.lockBaseline, (state) => ({
    ...state,
    locked: true,
    audit: [
      auditEvent(
        '签字锁定',
        '检测批次',
        `焊工资质、检测比例与返修闭环已确认；抽检组层级 ${state.groups.map((g) => `${g.drawing}/${g.joint}:${g.level}`).join('、')}`,
      ),
      ...state.audit,
    ],
  })),
  on(A.recordDefect, (state, { weldId, defect }) => {
    const weld = state.welds.find((w) => w.id === weldId)
    if (!weld) return state
    const nextStatus =
      defect.level === 'Ⅲ级' || defect.level === 'Ⅳ级'
        ? '返修中'
        : defect.level === 'Ⅱ级'
          ? '待复检'
          : weld.status
    const welds = state.welds.map((w) =>
      w.id === weldId ? { ...w, defects: [...w.defects, defect], status: nextStatus } : w,
    )
    const groupId = groupIdFor(weld.drawing, weld.joint)
    const recalc = applyRecalc({ ...state, welds }, groupId)
    return {
      ...state,
      welds,
      groups: recalc.groups,
      plans: recalc.plans,
      queue: recalc.queue,
      version: state.version + 1,
      audit: [
        auditEvent('录入缺陷', weldId, `新增缺陷 ${defect.type} ${defect.level}（${defect.length}mm，${defect.method}），触发重算`),
        ...recalc.audit,
      ],
    }
  }),
  on(A.setRepairs, (state, { weldId, repairs }) => {
    const weld = state.welds.find((w) => w.id === weldId)
    if (!weld) return state
    const welds = state.welds.map((w) => (w.id === weldId ? { ...w, repairs } : w))
    const groupId = groupIdFor(weld.drawing, weld.joint)
    const recalc = applyRecalc({ ...state, welds }, groupId)
    return {
      ...state,
      welds,
      groups: recalc.groups,
      plans: recalc.plans,
      queue: recalc.queue,
      version: state.version + 1,
      audit: [
        auditEvent('返修次数', weldId, `返修次数变更为 ${repairs}，触发重算`),
        ...recalc.audit,
      ],
    }
  }),
  on(A.recalcGroup, (state, { groupId }) => {
    const recalc = applyRecalc(state, groupId)
    return {
      ...state,
      groups: recalc.groups,
      plans: recalc.plans,
      queue: recalc.queue,
      version: state.version + 1,
      audit: recalc.audit,
    }
  }),
  on(A.recalcAllGroups, (state) => {
    let groups = state.groups
    let plans = state.plans
    let queue = state.queue
    let audit = state.audit
    for (const group of state.groups) {
      const recalc = applyRecalc({ ...state, groups, plans, queue, audit }, group.id)
      groups = recalc.groups
      plans = recalc.plans
      queue = recalc.queue
      audit = recalc.audit
    }
    return { ...state, groups, plans, queue, version: state.version + 1, audit }
  }),
  on(A.commitGroupLevel, (state, { groupId, level, actor, baseVersion }) => {
    const group = state.groups.find((g) => g.id === groupId)
    if (!group) return state
    const result = commitLevel(group, level, actor, new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }), baseVersion)
    const events = result.conflict
      ? [
          auditEvent(
            '层级冲突',
            groupId,
            `${actor} 提交 ${level}（基线 v${baseVersion}）已过期，先到结果 v${group.version} 保留，后到内容作为差异待处理`,
          ),
          ...state.audit,
        ]
      : [
          auditEvent('确认层级', groupId, `${actor} 确认层级 ${level}，版本 v${group.version} → v${result.group.version}`),
          ...state.audit,
        ]
    return {
      ...state,
      groups: state.groups.map((g) => (g.id === groupId ? result.group : g)),
      version: state.version + 1,
      audit: events,
    }
  }),
  on(A.resolveGroupDiff, (state, { groupId, adopt }) => {
    const group = state.groups.find((g) => g.id === groupId)
    if (!group || !group.pendingDiff) return state
    const updated = adopt ? adoptDiff(group) : keepFirst(group)
    return {
      ...state,
      groups: state.groups.map((g) => (g.id === groupId ? updated : g)),
      version: state.version + 1,
      audit: [
        auditEvent(
          adopt ? '采纳差异' : '保留先到',
          groupId,
          adopt ? `采纳后到差异，层级为 ${updated.level}` : `保留先到结果 ${updated.level}，忽略后到差异`,
        ),
        ...state.audit,
      ],
    }
  }),
  on(A.restoreGroupLevel, (state, { groupId }) => {
    const group = state.groups.find((g) => g.id === groupId)
    if (!group) return state
    const restored = restoreLevel(group)
    return {
      ...state,
      groups: state.groups.map((g) => (g.id === groupId ? restored : g)),
      version: state.version + 1,
      audit: [auditEvent('恢复层级', groupId, `调整失败，恢复上次确认层级 ${restored.level}`), ...state.audit],
    }
  }),
  on(A.scheduleGroup, (state, { groupId, startDate, method }) => {
    const group = state.groups.find((g) => g.id === groupId)
    if (!group) return state
    const sched = scheduleSamples(group, state.capacity, startDate, method)
    const gapNote = sched.gaps.length ? sched.gaps.join('；') : undefined
    const updatedGroup = { ...group, gapNote }
    return {
      ...state,
      groups: state.groups.map((g) => (g.id === groupId ? updatedGroup : g)),
      queue: [...sched.items, ...state.queue.filter((q) => q.groupId !== groupId)],
      version: state.version + 1,
      audit: [
        auditEvent(
          '容量排期',
          groupId,
          `按每日容量（检验员 ${state.capacity.inspectorDaily} 人 / 超声仪 ${state.capacity.utDaily} 台）排期 ${sched.items.length} 条，顺延 ${sched.postponed} 条${gapNote ? '；' + gapNote : ''}`,
        ),
        ...state.audit,
      ],
    }
  }),
  on(A.setCapacity, (state, { capacity }) => ({
    ...state,
    capacity,
    audit: [
      auditEvent('调整容量', '全部', `每日容量调整为 检验员 ${capacity.inspectorDaily} 人 / 超声仪 ${capacity.utDaily} 台`),
      ...state.audit,
    ],
  })),
)
