export type WeldStatus = '待检测' | '合格' | '返修中' | '待复检' | '已关闭'
export type DefectLevel = 'Ⅰ级' | 'Ⅱ级' | 'Ⅲ级' | 'Ⅳ级'

/** 分级抽检层级：正常 / 加严 / 全检，等级越高抽检比例越高 */
export type SamplingLevel = '正常' | '加严' | '全检'
export type GroupStatus = '已确认' | '待确认' | '差异待处理'
export type QueueStatus = '已排期' | '排队中' | '已顺延'

/** 两人同时修改同一层级时，后到的内容作为差异待处理 */
export interface LevelDiff {
  level: SamplingLevel
  actor: string
  time: string
  baseVersion: number
}

/** 抽检组：同一图纸 + 同一接头类型的焊缝共用一个层级 */
export interface SamplingGroup {
  id: string
  drawing: string
  joint: string
  /** 当前工作层级（可能未确认） */
  level: SamplingLevel
  /** 上次确认的层级，调整失败后可恢复 */
  confirmedLevel: SamplingLevel
  /** 乐观锁版本号，先到结果保留 */
  version: number
  weldIds: string[]
  /** 已采用（已出报告 / 已关闭）样本，重算时不重复抽取 */
  adoptedWeldIds: string[]
  /** 本次补入新样本的焊缝 */
  plannedWeldIds: string[]
  /** 已失效的未开始计划 */
  invalidatedPlanIds: string[]
  status: GroupStatus
  pendingDiff?: LevelDiff
  /** 容量缺口说明 */
  gapNote?: string
}

/** 排期队列：检验员与超声仪每日容量不足时排队，排不进去写明缺口并顺延 */
export interface QueueItem {
  weldId: string
  groupId: string
  day: string
  method: string
  status: QueueStatus
  gap?: string
}

/** 每日容量：现场检验员人数 × 超声仪台数 */
export interface CapacityConfig {
  inspectorDaily: number
  utDaily: number
}

export interface Defect {
  id: string
  position: number
  type: string
  length: number
  level: DefectLevel
  method: string
  report: string
}

export interface Weld {
  id: string
  drawing: string
  component: string
  joint: string
  method: string
  welder: string
  qualification: string
  qualificationValid: boolean
  inspectionRatio: number
  requiredRatio: number
  status: WeldStatus
  x: number
  y: number
  repairs: number
  defects: Defect[]
}

export interface InspectionPlan {
  id: string
  date: string
  method: string
  weldIds: string[]
  inspector: string
  state: '待执行' | '执行中' | '已完成' | '已失效'
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}
