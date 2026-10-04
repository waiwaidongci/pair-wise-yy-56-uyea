import type { SampleTier, TierConflict } from '../types'
import { nowTime } from './sampling'

export interface TierChangeRequest {
  actor: string
  tier: SampleTier
  reason: string
}

export interface TierSubmitOutcome {
  accepted: boolean
  conflict?: TierConflict
}

export interface ConflictResolution {
  conflict: TierConflict
  /** 合并时需要应用到组内的新层级内容（来自后到者） */
  adopt?: { tier: SampleTier; reason: string }
}

/**
 * 两个人同时修改同一份层级：
 * 同一组、同一修订上先到的修改保留为工作结果，后到的内容不覆盖，
 * 作为差异（TierConflict）挂起待处理，可在审核页合并或忽略。
 */
export class TierConcurrencyBoard {
  private pending = new Map<string, TierChangeRequest>()
  conflicts: TierConflict[] = []
  private seq = 0

  submit(groupId: string, revision: number, req: TierChangeRequest): TierSubmitOutcome {
    const key = `${groupId}@${revision}`
    const first = this.pending.get(key)
    if (!first) {
      this.pending.set(key, req)
      return { accepted: true }
    }
    // 同一人重复提交、或内容完全一致，视为同一份修改，不产生差异
    if (first.actor === req.actor || (first.tier === req.tier && first.reason === req.reason)) {
      return { accepted: true }
    }
    const conflict: TierConflict = {
      id: `CF-${++this.seq}`,
      groupId, revision, time: nowTime(),
      firstActor: first.actor, firstTier: first.tier, firstReason: first.reason,
      laterActor: req.actor, laterTier: req.tier, laterReason: req.reason,
      state: '待处理',
    }
    this.conflicts.push(conflict)
    return { accepted: false, conflict }
  }

  /** 修订经审核快照确认后，释放该修订的占用 */
  release(groupId: string, revision: number) {
    this.pending.delete(`${groupId}@${revision}`)
  }

  resolveConflict(id: string, decision: 'merge' | 'ignore'): ConflictResolution | undefined {
    const conflict = this.conflicts.find((c) => c.id === id)
    if (!conflict || conflict.state !== '待处理') return undefined
    if (decision === 'ignore') {
      conflict.state = '已忽略'
      return { conflict }
    }
    conflict.state = '已合并'
    // 合并：采用后到者的层级内容，重新挂为待确认修订
    this.pending.set(`${conflict.groupId}@${conflict.revision}`, {
      actor: conflict.laterActor, tier: conflict.laterTier, reason: conflict.laterReason,
    })
    return {
      conflict,
      adopt: { tier: conflict.laterTier, reason: `${conflict.laterReason}（合并 ${conflict.laterActor} 的差异）` },
    }
  }
}
