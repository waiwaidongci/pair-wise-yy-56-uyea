export type WeldStatus = '待检测' | '合格' | '返修中' | '待复检' | '已关闭'
export type DefectLevel = 'Ⅰ级' | 'Ⅱ级' | 'Ⅲ级' | 'Ⅳ级'

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

export type PlanState = '待执行' | '执行中' | '已完成' | '已失效'

export interface InspectionPlan {
  id: string
  date: string
  method: string
  weldIds: string[]
  inspector: string
  state: PlanState
  /** 失效/补样溯源：失效于哪个层级修订，替代计划是谁 */
  invalidatedRevision?: number
  replacedBy?: string
  batchNo?: string
}

/* ---------- 分级抽检领域模型 ---------- */

export type SampleTier = '放宽' | '正常' | '加严'

/** 组内层级状态：未确认的重算结果等待审核快照确认 */
export type TierStatus = '有效' | '待确认'

export interface TierPolicy {
  tier: SampleTier
  /** 组内抽检比例（百分比） */
  ratio: number
  trigger: string
}

export interface SamplingGroup {
  id: string
  drawing: string
  joint: string
  weldIds: string[]
  tier: SampleTier
  status: TierStatus
  /** 驱动当前层级的依据（缺陷等级 / 返修次数） */
  reason: string
  /** 层级修订号：缺陷等级或返修次数每变化一次递增 */
  revision: number
  revisionTime: string
  /** 最近一次被覆盖的层级（冲突待处理或回滚时使用） */
  previousTier?: SampleTier
  batchSeq: number
}

export type SampleState = '待排程' | '已排程' | '执行中' | '已出报告' | '已失效' | '原批次保留'

export interface SamplePick {
  id: string
  weldId: string
  groupId: string
  tier: SampleTier
  batchNo: string
  /** 抽中时所属层级修订；组内层级再变时用于失效判定 */
  revision: number
  state: SampleState
  /** 已采用的样本不重复抽取：一旦被计划采用即置真，失效后回到候选池 */
  adopted: boolean
  planId?: string
  scheduledDate?: string
  inspector?: string
  instrument?: string
  /** 排不进去时写明缺口 */
  gap?: string
}

export interface DailyCapacity {
  date: string
  inspectorCapacity: number
  instrumentCapacity: number
}

export interface CapacityGap {
  id: string
  groupId: string
  weldId: string
  fromDate: string
  resource: '检验员' | '超声仪'
  required: number
  available: number
  note: string
  resolvedDate?: string
  resolved: boolean
}

/** 两个人同时修改同一份层级：先到结果保留，后到内容作为差异待处理 */
export interface TierConflict {
  id: string
  groupId: string
  revision: number
  time: string
  firstActor: string
  firstTier: SampleTier
  firstReason: string
  laterActor: string
  laterTier: SampleTier
  laterReason: string
  state: '待处理' | '已合并' | '已忽略'
}

/** 审核快照：上次确认的层级，调整失败后可恢复 */
export interface TierSnapshot {
  id: string
  groupId: string
  revision: number
  tier: SampleTier
  reason: string
  time: string
  actor: string
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}
