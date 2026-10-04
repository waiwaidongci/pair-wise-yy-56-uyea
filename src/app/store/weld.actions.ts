import { createAction, props } from '@ngrx/store'
import type {
  DefectLevel, InspectionPlan, SampleTier, TierConflict, Weld, WeldStatus,
} from '../types'

export const loadWelds = createAction('[Weld] Load')
export const loadWeldsSuccess = createAction(
  '[Weld API] Load Success',
  props<{ welds: Weld[]; plans: InspectionPlan[] }>(),
)
export const selectWeld = createAction('[Weld] Select', props<{ id: string }>())
export const filterStatus = createAction('[Weld] Filter Status', props<{ status: string }>())
export const advanceWeld = createAction('[Weld] Advance', props<{ id: string; status: WeldStatus }>())
export const createPlan = createAction('[Inspection] Create Plan', props<{ plan: InspectionPlan }>())
export const lockBaseline = createAction('[Approval] Lock Baseline')

/* ---------- 分级抽检 ---------- */

/** 录入缺陷：等级变化即按图纸+接头类型重算组内层级 */
export const recordDefect = createAction(
  '[Sampling] Record Defect',
  props<{ weldId: string; defectType: string; level: DefectLevel; length: number; method: string; report: string }>(),
)

/** 登记一次返修：返修次数变化触发层级重算 */
export const registerRepair = createAction('[Sampling] Register Repair', props<{ weldId: string; note?: string }>())

/** 检测计划开始执行（执行中样本留在原批次） */
export const startPlan = createAction('[Sampling] Start Plan', props<{ planId: string }>())

/** 计划出报告：报告后的样本留在原批次，不被后续层级变更追溯 */
export const completePlan = createAction('[Sampling] Complete Plan', props<{ planId: string }>())

/** 两个人同时修改同一份层级：先到保留 */
export const proposeTier = createAction(
  '[Sampling] Propose Tier',
  props<{ groupId: string; tier: SampleTier; reason: string; actor: string }>(),
)

/** 后到内容产生差异时，把冲突登记待处理 */
export const tierConflictRaised = createAction('[Sampling] Tier Conflict Raised', props<{ conflict: TierConflict }>())

/** 审核快照确认层级（确认后释放并发占用） */
export const confirmTier = createAction('[Sampling] Confirm Tier', props<{ groupId: string; actor: string }>())

/** 合并差异：采用后到者内容，重新挂为待确认修订 */
export const adoptConflictTier = createAction('[Sampling] Adopt Conflict Tier', props<{ conflict: TierConflict }>())

/** 忽略差异：保留先到结果 */
export const dismissConflict = createAction('[Sampling] Dismiss Conflict', props<{ conflictId: string }>())

/** 调整失败后恢复上次确认的层级，并继续后续流程 */
export const rollbackTier = createAction('[Sampling] Rollback Tier', props<{ groupId: string }>())

/** 容量不足排队后，追加下一天容量并重新排队（顺延样本重排） */
export const extendCapacity = createAction('[Sampling] Extend Capacity')
