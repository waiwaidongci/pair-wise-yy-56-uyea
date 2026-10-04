import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { Store } from '@ngrx/store'
import { ButtonModule } from 'primeng/button'
import { TimelineModule } from 'primeng/timeline'
import { TagModule } from 'primeng/tag'
import { WeldState } from '../store/weld.reducer'
import * as A from '../store/weld.actions'
import type { SamplingGroup } from '../types'

@Component({
  selector:'app-approvals', standalone:true, imports:[CommonModule,ButtonModule,TimelineModule,TagModule],
  template:`
    <main class="page"><div class="page-head"><div><p class="eyebrow">签字、版本与追溯</p><h1>逐段确认与锁定</h1><p>层级重算或人工调整先进入待确认；审核快照确认后生效，调整失败可恢复上次确认的层级并继续。</p></div><p-button [label]="state.locked ? '已锁定' : '签字锁定检测批次'" icon="pi pi-lock" [disabled]="state.locked" (onClick)="lock()" /></div>
      <div class="grid-2">
        <section class="card">
          <h2 class="panel-title">待确认层级修订</h2>
          <p class="muted" *ngIf="!pendingGroups.length">所有抽检组层级均已确认。</p>
          <div class="review tier-row" *ngFor="let g of pendingGroups">
            <div><b>{{g.drawing}}</b><small>{{g.joint}} · rev {{g.revision}}<span *ngIf="g.previousTier"> · 原层级 {{g.previousTier}}</span></small><small>{{g.reason}}</small></div>
            <p-tag [value]="g.tier" [severity]="g.tier === '加严' ? 'danger' : g.tier === '正常' ? 'warn' : 'success'" />
            <p-button label="确认并出快照" size="small" (onClick)="confirm(g)" />
            <p-button label="调整失败：恢复上次" severity="warn" text size="small" (onClick)="rollback(g)" />
          </div>
          <h2 class="panel-title mt-3">待审核焊缝</h2>
          <div class="review" *ngFor="let weld of reviewWelds"><div><b>{{weld.id}} · {{weld.component}}</b><small>{{weld.method}} · {{weld.welder}} · 返修 {{weld.repairs}} 次</small></div><p-tag [value]="weld.status" [severity]="weld.status === '待复检' ? 'warn' : 'danger'" /><p-button label="要求复检" severity="danger" text size="small" /><p-button label="确认合格" size="small" (onClick)="confirmWeld(weld.id)" /></div>
          <p-button label="导出质量追溯包" icon="pi pi-file-export" severity="secondary" styleClass="w-full mt-2" />
        </section>
        <aside class="card">
          <h2 class="panel-title">审核快照（上次确认的层级）</h2>
          <div class="snap" *ngFor="let s of state.snapshots">
            <div><b>{{s.groupId}}</b><small>rev {{s.revision}} · {{s.tier}} · {{s.actor}} @ {{s.time}}</small><small>{{s.reason}}</small></div>
            <p-tag value="可回滚" severity="secondary" />
          </div>
          <p class="muted mt-2">快照记录焊缝状态、缺陷等级、返修次数、层级比例与签字人；恢复后已采用样本不重复抽取，仅继续补样与排程。</p>
          <h2 class="panel-title mt-3">完整审计时间线</h2>
          <p-timeline [value]="state.audit.slice(0,18)" align="left"><ng-template #content let-event><div class="audit"><div><b>{{event.actor}} · {{event.action}}</b><span>{{event.time}}</span></div><p><strong>{{event.target}}</strong> {{event.detail}}</p></div></ng-template></p-timeline>
        </aside>
      </div>
      <section class="card mt-3"><h2 class="panel-title">版本快照</h2><div class="snapshot"><div><b>v{{state.version}}</b><small>当前工作版本 · {{state.welds.length}} 条焊缝 · {{state.plans.length}} 个检测计划 · {{state.groups.length}} 个抽检组</small></div><p-tag [value]="state.locked ? '已签字锁定' : '可编辑'" [severity]="state.locked ? 'success' : 'warn'" /></div><p class="muted mt-2">任何后续修改必须从当前版本派生新修订，不覆盖原始检测记录；已出报告样本永远留在原批次。</p></section>
    </main>
  `,
  styles:[`.review{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;padding:12px 0;border-bottom:1px solid #edf0f5}.review b,.review small{display:block}.review small{color:#7a8798;margin-top:4px}.tier-row{grid-template-columns:1fr auto auto auto;background:#fffbeb;border-radius:8px;padding:12px;margin-bottom:8px;border-bottom:none}.snap{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:10px;background:#f8fafc;border-radius:6px;margin-bottom:8px}.snap b,.snap small{display:block}.snap small{color:#7a8798;margin-top:3px;font-size:12px}.audit{background:#fff;border:1px solid #e1e7ef;border-radius:6px;padding:10px}.audit>div{display:flex;justify-content:space-between}.audit span{color:#7a8798;font-size:12px}.audit p{margin:5px 0 0;font-size:13px}.snapshot{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:12px;background:#f8fafc;border-radius:6px}.snapshot b,.snapshot small{display:block}.snapshot small{color:#7a8798;margin-top:4px}.muted{color:#7a8798}.mt-2{margin-top:10px}.mt-3{margin-top:16px}@media(max-width:760px){.review,.tier-row{grid-template-columns:1fr auto}.review .p-button{width:100%}}`],
})
export class ApprovalsComponent {
  private readonly store = inject(Store<{ welds: WeldState }>)
  state!: WeldState
  constructor() { this.store.select('welds').subscribe((state) => this.state = state) }
  get pendingGroups(): SamplingGroup[] { return (this.state?.groups ?? []).filter((g) => g.status === '待确认') }
  get reviewWelds() { return (this.state?.welds ?? []).filter((item) => ['待复检','返修中','待检测'].includes(item.status)) }
  confirm(g: SamplingGroup) { this.store.dispatch(A.confirmTier({ groupId: g.id, actor: '质量负责人' })) }
  rollback(g: SamplingGroup) { this.store.dispatch(A.rollbackTier({ groupId: g.id })) }
  confirmWeld(id: string) { this.store.dispatch(A.advanceWeld({ id, status:'合格' })) }
  lock() { this.store.dispatch(A.lockBaseline()) }
}
