import type { CapacityConfig, DefectLevel, InspectionPlan, QueueItem, SamplingGroup, SamplingLevel, Weld } from '../types'

/** 缺陷等级 → 抽检层级：出现高等级缺陷直接加严到全检 */
export function levelForDefect(level: DefectLevel): SamplingLevel {
  if (level === 'Ⅳ级' || level === 'Ⅲ级') return '全检'
  if (level === 'Ⅱ级') return '加严'
  return '正常'
}

/** 组内层级：取所有焊缝缺陷与返修次数的最严档 */
export function levelForWelds(welds: Weld[]): SamplingLevel {
  let level: SamplingLevel = '正常'
  for (const weld of welds) {
    for (const defect of weld.defects) {
      const next = levelForDefect(defect.level)
      if (next === '全检') return '全检'
      if (next === '加严') level = '加严'
    }
    if (weld.repairs >= 3) return '全检'
    if (weld.repairs >= 2) level = '加严'
  }
  return level
}

/** 层级 → 抽检比例：全检 100%，加严翻倍（封顶 100%），正常按规范要求 */
export function ratioForLevel(level: SamplingLevel, requiredRatio: number): number {
  if (level === '全检') return 100
  if (level === '加严') return Math.min(100, requiredRatio * 2)
  return requiredRatio
}

export function methodForLevel(level: SamplingLevel): string {
  if (level === '全检') return 'UT + MT'
  if (level === '加严') return 'UT'
  return 'UT'
}

export function groupIdFor(drawing: string, joint: string): string {
  return `${drawing} / ${joint}`
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 已采用样本：已出报告 / 已关闭，或已列入执行中、已完成计划的焊缝，不重复抽取 */
export function adoptedWeldIds(welds: Weld[], plans: InspectionPlan[]): Set<string> {
  const adopted = new Set<string>()
  for (const weld of welds) {
    if (weld.status === '合格' || weld.status === '已关闭') adopted.add(weld.id)
  }
  for (const plan of plans) {
    if (plan.state === '执行中' || plan.state === '已完成') {
      plan.weldIds.forEach((id) => adopted.add(id))
    }
  }
  return adopted
}

/** 从组内抽取样本：排除已采用样本，按比例抽取（全检则全部入样） */
export function selectSampleIds(pool: Weld[], ratio: number): string[] {
  if (ratio >= 100) return pool.map((w) => w.id)
  const target = Math.max(1, Math.ceil((pool.length * ratio) / 100))
  return pool.slice(0, target).map((w) => w.id)
}

/** 由焊缝与计划构建抽检组（图纸 + 接头类型） */
export function buildGroups(welds: Weld[], plans: InspectionPlan[]): SamplingGroup[] {
  const map = new Map<string, SamplingGroup>()
  for (const weld of welds) {
    const id = groupIdFor(weld.drawing, weld.joint)
    if (!map.has(id)) {
      map.set(id, {
        id,
        drawing: weld.drawing,
        joint: weld.joint,
        level: '正常',
        confirmedLevel: '正常',
        version: 1,
        weldIds: [],
        adoptedWeldIds: [],
        plannedWeldIds: [],
        invalidatedPlanIds: [],
        status: '已确认',
      })
    }
    map.get(id)!.weldIds.push(weld.id)
  }
  const adopted = adoptedWeldIds(welds, plans)
  for (const group of map.values()) {
    const groupWelds = group.weldIds.map((id) => welds.find((w) => w.id === id)!).filter(Boolean)
    group.level = levelForWelds(groupWelds)
    group.confirmedLevel = group.level
    group.adoptedWeldIds = group.weldIds.filter((id) => adopted.has(id))
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export interface RecalcResult {
  group: SamplingGroup
  changed: boolean
  previousLevel: SamplingLevel
  invalidatedPlanIds: string[]
  sampleIds: string[]
  ratio: number
  method: string
}

/**
 * 缺陷等级或返修次数一变，按图纸 + 接头类型重算组内层级：
 * 未开始的计划失效、补入新样本，已出报告的留在原批次。
 */
export function recalcGroup(group: SamplingGroup, welds: Weld[], plans: InspectionPlan[]): RecalcResult {
  const groupWelds = group.weldIds.map((id) => welds.find((w) => w.id === id)!).filter(Boolean)
  const newLevel = levelForWelds(groupWelds)
  const changed = newLevel !== group.level
  const adopted = adoptedWeldIds(welds, plans)
  const pool = groupWelds.filter((w) => !adopted.has(w.id))
  const requiredRatio = Math.max(0, ...groupWelds.map((w) => w.requiredRatio))
  const ratio = ratioForLevel(newLevel, requiredRatio)
  const sampleIds = selectSampleIds(pool, ratio)
  const invalidatedPlanIds = plans
    .filter((p) => p.state === '待执行' && p.weldIds.some((id) => group.weldIds.includes(id)))
    .map((p) => p.id)
  return {
    group: {
      ...group,
      level: newLevel,
      adoptedWeldIds: group.weldIds.filter((id) => adopted.has(id)),
      plannedWeldIds: sampleIds,
      invalidatedPlanIds: [...group.invalidatedPlanIds, ...invalidatedPlanIds],
      status: '待确认',
      gapNote: undefined,
    },
    changed,
    previousLevel: group.level,
    invalidatedPlanIds,
    sampleIds,
    ratio,
    method: methodForLevel(newLevel),
  }
}

/** 有效日容量：超声检测受检验员与超声仪双重约束，取小值 */
export function effectiveCapacity(capacity: CapacityConfig, method: string): number {
  if (method.includes('UT')) return Math.min(capacity.inspectorDaily, capacity.utDaily)
  return capacity.inspectorDaily
}

export interface ScheduleResult {
  items: QueueItem[]
  gaps: string[]
  postponed: number
}

/**
 * 按每日容量排期：检验员与超声仪容量不足则排队，
 * 排不进去的样本写明缺口并顺延到下一批。
 */
export function scheduleSamples(
  group: SamplingGroup,
  capacity: CapacityConfig,
  startDate: string,
  method: string,
): ScheduleResult {
  const cap = effectiveCapacity(capacity, method)
  const items: QueueItem[] = []
  const gaps: string[] = []
  const batches: { day: string; ids: string[] }[] = []
  group.plannedWeldIds.forEach((weldId, idx) => {
    const dayIndex = Math.floor(idx / cap)
    if (!batches[dayIndex]) batches[dayIndex] = { day: addDays(startDate, dayIndex), ids: [] }
    batches[dayIndex].ids.push(weldId)
  })
  batches.forEach((batch, dayIndex) => {
    batch.ids.forEach((weldId) => {
      if (dayIndex === 0) {
        items.push({ weldId, groupId: group.id, day: batch.day, method, status: '已排期' })
      } else {
        const gap = `缺口：${batches[dayIndex - 1].day} 容量 ${cap} 条已满（检验员 ${capacity.inspectorDaily} 人 / 超声仪 ${capacity.utDaily} 台），${batch.ids.length} 条顺延至 ${batch.day}`
        items.push({ weldId, groupId: group.id, day: batch.day, method, status: '已顺延', gap })
      }
    })
    if (dayIndex > 0) {
      const gapNote = `容量不足：每日有效容量 ${cap} 条，第 ${dayIndex + 1} 批 ${batch.ids.length} 条顺延 ${dayIndex} 天至 ${batch.day}`
      if (!gaps.includes(gapNote)) gaps.push(gapNote)
    }
  })
  return { items, gaps, postponed: items.filter((i) => i.status !== '已排期').length }
}

export interface CommitResult {
  group: SamplingGroup
  conflict: boolean
}

/**
 * 两人同时修改同一份层级：先到结果保留（版本号一致才提交），
 * 后到内容作为差异待处理，不覆盖先到结果。
 */
export function commitLevel(
  group: SamplingGroup,
  level: SamplingLevel,
  actor: string,
  time: string,
  baseVersion: number,
): CommitResult {
  if (baseVersion === group.version) {
    return {
      group: {
        ...group,
        level,
        confirmedLevel: level,
        version: group.version + 1,
        status: '已确认',
        pendingDiff: undefined,
      },
      conflict: false,
    }
  }
  return {
    group: {
      ...group,
      level: group.level,
      status: '差异待处理',
      pendingDiff: { level, actor, time, baseVersion },
    },
    conflict: true,
  }
}

/** 采纳后到的差异：以差异层级为准提交 */
export function adoptDiff(group: SamplingGroup): SamplingGroup {
  if (!group.pendingDiff) return group
  return {
    ...group,
    level: group.pendingDiff.level,
    confirmedLevel: group.pendingDiff.level,
    version: group.version + 1,
    status: '已确认',
    pendingDiff: undefined,
  }
}

/** 保留先到结果，忽略后到差异 */
export function keepFirst(group: SamplingGroup): SamplingGroup {
  return { ...group, status: '已确认', pendingDiff: undefined }
}

/** 调整失败后恢复上次确认的层级并继续 */
export function restoreLevel(group: SamplingGroup): SamplingGroup {
  return { ...group, level: group.confirmedLevel, status: '已确认', pendingDiff: undefined, gapNote: undefined }
}
