import { createAction, props } from '@ngrx/store'
import type { CapacityConfig, Defect, InspectionPlan, SamplingLevel, Weld, WeldStatus } from '../types'

export const loadWelds = createAction('[Weld] Load')
export const loadWeldsSuccess = createAction('[Weld API] Load Success', props<{ welds: Weld[]; plans: InspectionPlan[] }>())
export const selectWeld = createAction('[Weld] Select', props<{ id: string }>())
export const filterStatus = createAction('[Weld] Filter Status', props<{ status: string }>())
export const advanceWeld = createAction('[Weld] Advance', props<{ id: string; status: WeldStatus }>())
export const createPlan = createAction('[Inspection] Create Plan', props<{ plan: InspectionPlan }>())
export const lockBaseline = createAction('[Approval] Lock Baseline')

/** 录入检测结果（含缺陷等级），触发组内层级重算 */
export const recordDefect = createAction('[Inspection] Record Defect', props<{ weldId: string; defect: Defect }>())
/** 返修次数变化，触发组内层级重算 */
export const setRepairs = createAction('[Weld] Set Repairs', props<{ weldId: string; repairs: number }>())

/** 按图纸 + 接头类型重算单个抽检组 */
export const recalcGroup = createAction('[Sampling] Recalc Group', props<{ groupId: string }>())
/** 重算全部抽检组 */
export const recalcAllGroups = createAction('[Sampling] Recalc All Groups')
/** 确认层级（带版本号，先到结果保留） */
export const commitGroupLevel = createAction('[Sampling] Commit Level', props<{ groupId: string; level: SamplingLevel; actor: string; baseVersion: number }>())
/** 处理两人同时修改产生的差异：adopt=true 采纳后到内容，false 保留先到结果 */
export const resolveGroupDiff = createAction('[Sampling] Resolve Diff', props<{ groupId: string; adopt: boolean }>())
/** 调整失败后恢复上次确认的层级 */
export const restoreGroupLevel = createAction('[Sampling] Restore Level', props<{ groupId: string }>())
/** 按每日容量排期，排队样本写明缺口并顺延 */
export const scheduleGroup = createAction('[Sampling] Schedule Group', props<{ groupId: string; startDate: string; method: string }>())
/** 调整检验员 / 超声仪每日容量 */
export const setCapacity = createAction('[Sampling] Set Capacity', props<{ capacity: CapacityConfig }>())
