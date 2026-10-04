import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { Store } from '@ngrx/store'
import { TableModule } from 'primeng/table'
import { TagModule } from 'primeng/tag'
import { ButtonModule } from 'primeng/button'
import { DialogModule } from 'primeng/dialog'
import { SelectModule } from 'primeng/select'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { WeldState } from '../store/weld.reducer'
import * as A from '../store/weld.actions'
import { TIER_POLICIES } from '../domain/sampling'
import type {
  DefectLevel, SamplePick, SamplingGroup, SampleTier, Weld,
} from '../types'

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary'

@Component({
  selector: 'app-sampling',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, DialogModule, SelectModule, InputTextModule, TextareaModule],
  template: `
    <main class="page">
      <div class="page-head">
        <div>
          <p class="eyebrow">分级抽检 / 容量排队 / 差异审核</p>
          <h1>焊缝分级抽检调度</h1>
          <p>缺陷等级或返修次数一变，按图纸 + 接头类型重算组内层级；未开始计划失效后补入新样本，已出报告留在原批次。</p>
        </div>
        <div class="head-actions">
          <p-button label="扩充一周容量" icon="pi pi-calendar-plus" severity="secondary" (onClick)="store.dispatch(A.extendCapacity())" />
          <p-button label="录入缺陷 / 触发重算" icon="pi pi-exclamation-triangle" (onClick)="defectDialog = true" />
        </div>
      </div>

      <div class="grid-4">
        <article class="card metric"><span>抽检组</span><strong>{{state.groups.length}}</strong><small>按图纸 + 接头类型分组</small></article>
        <article class="card metric"><span>待确认层级修订</span><strong class="warning">{{pendingGroups}}</strong><small>重算或人工调整等待快照</small></article>
        <article class="card metric"><span>容量缺口（顺延中）</span><strong class="danger">{{openGaps}}</strong><small>检验员 / 超声仪每日容量不足</small></article>
        <article class="card metric"><span>层级差异待处理</span><strong [class.danger]="openConflicts">{{openConflicts}}</strong><small>两人同改一份层级，后到挂起</small></article>
      </div>

      <!-- 组内层级 -->
      <section class="card">
        <h2 class="panel-title">抽检组层级（缺陷等级 / 返修次数驱动）</h2>
        <p-table [value]="state.groups" [paginator]="true" [rows]="6">
          <ng-template #header>
            <tr><th>抽检组（图纸 # 接头）</th><th>当前层级 / 比例</th><th>修订 / 状态</th><th>层级依据</th><th>组内焊缝</th><th>操作</th></tr>
          </ng-template>
          <ng-template #body let-group>
            <tr [class.pending-row]="group.status === '待确认'">
              <td><b>{{group.drawing}}</b><small class="block">{{group.joint}}</small></td>
              <td><p-tag [value]="group.tier" [severity]="tierSeverity(group.tier)" /><small class="block">{{ratioOf(group.tier)}}% 组内抽检</small></td>
              <td><p-tag [value]="'rev ' + group.revision" severity="secondary" /><p-tag class="ml-1" [value]="group.status" [severity]="group.status === '有效' ? 'success' : 'warn'" /><small class="block" *ngIf="group.previousTier">原层级 {{group.previousTier}}</small></td>
              <td>{{group.reason}}</td>
              <td><span class="weld-chips"><i *ngFor="let id of group.weldIds">{{id}}</i></span></td>
              <td class="ops">
                <ng-container *ngIf="group.status === '待确认'">
                  <p-button label="快照确认" icon="pi pi-check-circle" size="small" (onClick)="store.dispatch(A.confirmTier({ groupId: group.id, actor: '质量负责人' }))" />
                  <p-button label="恢复上次确认" icon="pi pi-undo" size="small" severity="warn" text (onClick)="store.dispatch(A.rollbackTier({ groupId: group.id }))" />
                </ng-container>
                <p-button label="人工改层级" icon="pi pi-sliders-h" size="small" severity="secondary" text (onClick)="openTierDialog(group)" />
              </td>
            </tr>
          </ng-template>
        </p-table>
      </section>

      <div class="grid-2 mt-3">
        <!-- 样本与批次 -->
        <section class="card">
          <h2 class="panel-title">抽样批次与计划联动</h2>
          <p-table [value]="state.picks" [paginator]="true" [rows]="8" dataKey="id">
            <ng-template #header>
              <tr><th>焊缝</th><th>批次 / 修订</th><th>排程 / 资源</th><th>样本状态</th></tr>
            </ng-template>
            <ng-template #body let-pick>
              <tr [class.stale-row]="pick.state === '已失效'">
                <td><b>{{pick.weldId}}</b><small class="block">{{pick.groupId}}</small></td>
                <td>{{pick.batchNo}}<small class="block">rev {{pick.revision}} · {{pick.tier}}</small></td>
                <td>{{pick.scheduledDate || '—'}}<small class="block" *ngIf="pick.inspector">{{pick.inspector}} · {{pick.instrument}}</small><small class="block danger" *ngIf="pick.gap">⚠ {{pick.gap}}</small></td>
                <td><p-tag [value]="pick.state" [severity]="pickSeverity(pick.state)" /></td>
              </tr>
            </ng-template>
          </p-table>
        </section>

        <!-- 并发差异 -->
        <section class="card">
          <h2 class="panel-title">层级修改差异（先到保留，后到待处理）</h2>
          <p class="muted" *ngIf="!state.conflicts.length">暂无并修改冲突。可在下方用两个身份连续修改同一组层级进行模拟。</p>
          <div class="conflict" *ngFor="let c of state.conflicts">
            <div class="conflict-head">
              <b>{{c.groupId}} · rev {{c.revision}}</b>
              <p-tag [value]="c.state" [severity]="c.state === '待处理' ? 'danger' : 'secondary'" />
            </div>
            <div class="conflict-body">
              <div class="first"><span>先到 · 已保留</span><b>{{c.firstActor}}：{{c.firstTier}}</b><small>{{c.firstReason}}</small></div>
              <i class="pi pi-arrow-right"></i>
              <div class="later"><span>后到 · 差异待处理</span><b>{{c.laterActor}}：{{c.laterTier}}</b><small>{{c.laterReason}}</small></div>
            </div>
            <div class="conflict-ops" *ngIf="c.state === '待处理'">
              <p-button label="合并后到内容" icon="pi pi-check" size="small" (onClick)="store.dispatch(A.adoptConflictTier({ conflict: c }))" />
              <p-button label="保留先到结果" icon="pi pi-times" size="small" severity="secondary" text (onClick)="store.dispatch(A.dismissConflict({ conflictId: c.id }))" />
            </div>
            <small class="block muted">合并后后到内容挂为待确认修订，仍需快照确认才生效；忽略则先到层级不动。</small>
          </div>
        </section>
      </div>

      <div class="grid-2 mt-3">
        <!-- 计划失效/补样 -->
        <section class="card">
          <h2 class="panel-title">检测计划（失效补样 / 原批次保留）</h2>
          <p-table [value]="state.plans" [paginator]="true" [rows]="7">
            <ng-template #header>
              <tr><th>计划</th><th>日期 / 焊缝</th><th>检测人</th><th>状态 / 溯源</th><th></th></tr>
            </ng-template>
            <ng-template #body let-plan>
              <tr [class.stale-row]="plan.state === '已失效'">
                <td><b>{{plan.id}}</b><small class="block">{{plan.method}}<span *ngIf="plan.batchNo"> · {{plan.batchNo}}</span></small></td>
                <td>{{plan.date}}<small class="block">{{plan.weldIds.join('、')}}</small></td>
                <td>{{plan.inspector}}</td>
                <td>
                  <p-tag [value]="plan.state" [severity]="planSeverity(plan.state)" />
                  <small class="block" *ngIf="plan.state === '已失效'">层级 rev {{plan.invalidatedRevision}} 变更失效<ng-container *ngIf="plan.replacedBy">，已由 {{plan.replacedBy}} 补入</ng-container></small>
                </td>
                <td class="ops">
                  <p-button *ngIf="plan.state === '待执行'" label="开始" icon="pi pi-play" size="small" text (onClick)="store.dispatch(A.startPlan({ planId: plan.id }))" />
                  <p-button *ngIf="plan.state === '执行中'" label="出报告" icon="pi pi-file" size="small" text (onClick)="store.dispatch(A.completePlan({ planId: plan.id }))" />
                </td>
              </tr>
            </ng-template>
          </p-table>
        </section>

        <!-- 容量缺口 -->
        <section class="card">
          <h2 class="panel-title">检验员 / 超声仪每日容量与缺口</h2>
          <div class="cap-list">
            <div class="cap-row" *ngFor="let c of state.capacities">
              <b>{{c.date}}</b>
              <span>检验员 {{c.inspectorCapacity}}/日</span>
              <span>超声仪 {{c.instrumentCapacity}}/日</span>
            </div>
          </div>
          <h3 class="mt-2">缺口清单（写明缺口并顺延）</h3>
          <p class="muted" *ngIf="!openGapRows().length">当前容量窗口内无未决缺口。</p>
          <div class="gap" *ngFor="let g of openGapRows()">
            <i class="pi pi-clock"></i>
            <div><b>{{g.weldId}} · 缺{{g.resource}}</b><p>{{g.note}}</p><small>自 {{g.fromDate}} 起容量不足</small></div>
          </div>
          <p-button class="mt-2" label="追加容量并重新排队" icon="pi pi-bolt" size="small" (onClick)="store.dispatch(A.extendCapacity())" />
        </section>
      </div>

      <!-- 人工调整层级（可切换身份模拟并发） -->
      <p-dialog header="人工调整组内层级" [(visible)]="tierDialog" [modal]="true" [style]="{width:'560px'}">
        <div class="form">
          <label>抽检组</label><input pInputText [value]="activeGroup?.id" disabled />
          <label>操作人（模拟两人同时修改）</label>
          <p-select [options]="actors" [(ngModel)]="actor" optionLabel="name" optionValue="name" />
          <label>调整为层级</label>
          <p-select [options]="tierOptions" [(ngModel)]="tierForm.tier" optionLabel="tier" optionValue="tier" />
          <label>调整依据</label>
          <textarea pTextarea [(ngModel)]="tierForm.reason" rows="3"></textarea>
        </div>
        <ng-template #footer>
          <p-button label="取消" severity="secondary" (onClick)="tierDialog = false" />
          <p-button label="提交修改" (onClick)="submitTier()" />
        </ng-template>
      </p-dialog>

      <!-- 录入缺陷 -->
      <p-dialog header="录入缺陷（触发层级重算）" [(visible)]="defectDialog" [modal]="true" [style]="{width:'600px'}">
        <div class="form">
          <label>焊缝</label>
          <p-select [options]="inspectableWelds" [(ngModel)]="defectForm.weldId" optionLabel="id" optionValue="id" placeholder="选择焊缝" />
          <label>缺陷类型</label>
          <input pInputText [(ngModel)]="defectForm.type" placeholder="如：未熔合 / 夹渣" />
          <label>缺陷等级（等级变化即重算）</label>
          <p-select [options]="levels" [(ngModel)]="defectForm.level" optionLabel="name" optionValue="name" />
          <label>长度（mm）</label>
          <input pInputText type="number" [(ngModel)]="defectForm.length" />
          <label>检测方法 / 报告编号</label>
          <input pInputText [(ngModel)]="defectForm.report" placeholder="如：UT · UT-2026-1005-01" />
        </div>
        <ng-template #footer>
          <p-button label="取消" severity="secondary" (onClick)="defectDialog = false" />
          <p-button label="提交并重算" (onClick)="submitDefect()" />
        </ng-template>
      </p-dialog>
    </main>
  `,
  styles: [`
    .head-actions{display:flex;gap:10px}.block{display:block}.mt-2{margin-top:10px}.mt-3{margin-top:16px}.ml-1{margin-left:4px}
    .pending-row{background:#fffbeb}.stale-row{opacity:.55;text-decoration:line-through;color:#94a3b8}.stale-row p-tag{text-decoration:none}
    .weld-chips{display:flex;flex-wrap:wrap;gap:4px}.weld-chips i{font-style:normal;background:#eef2ff;color:#3730a3;border-radius:4px;padding:2px 6px;font-size:12px}
    .ops{display:flex;gap:4px;flex-wrap:wrap;white-space:nowrap}
    .conflict{border:1px solid #fecaca;background:#fef2f2;border-radius:8px;padding:12px;margin-bottom:10px}
    .conflict-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
    .conflict-body{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;margin-bottom:8px}
    .conflict-body>i{color:#94a3b8}.conflict-body span{display:block;font-size:11px;color:#667085}.conflict-body b,.conflict-body small{display:block}
    .conflict-body .first{background:#f0fdf4;border-left:3px solid #16a34a;padding:6px 8px;border-radius:4px}
    .conflict-body .later{background:#fff;border-left:3px solid #dc2626;padding:6px 8px;border-radius:4px}
    .conflict-ops{display:flex;gap:8px;margin:8px 0 4px}.muted{color:#7a8798}
    .cap-list{display:flex;flex-direction:column;gap:6px}.cap-row{display:grid;grid-template-columns:1fr auto auto;gap:12px;padding:8px 10px;background:#f8fafc;border-radius:6px;font-size:13px}
    .gap{display:flex;gap:10px;padding:10px;background:#fff7ed;border-left:3px solid #ea580c;border-radius:5px;margin-top:8px}
    .gap i{color:#ea580c}.gap p{margin:3px 0;font-size:13px}.gap small{color:#94a3b8}
    .form{display:grid;gap:9px}.form label{font-size:13px;color:#475569}
  `],
})
export class SamplingComponent {
  readonly store = inject(Store<{ welds: WeldState }>)
  state!: WeldState
  readonly A = A

  tierDialog = false
  defectDialog = false
  activeGroup: SamplingGroup | undefined
  actors = [{ name: '陈锋' }, { name: '赵岚' }, { name: '第三方检测员' }]
  actor = '陈锋'
  tierForm: { groupId: string; tier: SampleTier; reason: string } = { groupId: '', tier: '加严', reason: '' }
  tierOptions = (['放宽', '正常', '加严'] as SampleTier[]).map((t) => ({ tier: t }))
  levels = (['Ⅰ级', 'Ⅱ级', 'Ⅲ级', 'Ⅳ级'] as DefectLevel[]).map((name) => ({ name }))
  defectForm: { weldId: string; type: string; level: DefectLevel; length: number; report: string } = {
    weldId: '', type: '未熔合', level: 'Ⅲ级', length: 15, report: 'UT-2026-1005-01',
  }

  constructor() {
    this.store.select('welds').subscribe((state) => this.state = state)
  }

  get pendingGroups() { return (this.state?.groups ?? []).filter((g) => g.status === '待确认').length }
  get openGaps() { return (this.state?.gaps ?? []).filter((g) => !g.resolved).length }
  get openConflicts() { return (this.state?.conflicts ?? []).filter((c) => c.state === '待处理').length }
  get inspectableWelds(): Weld[] {
    return (this.state?.welds ?? []).filter((w) => ['待检测', '返修中', '待复检'].includes(w.status))
  }

  openGapRows() { return (this.state?.gaps ?? []).filter((g) => !g.resolved) }

  openTierDialog(group: SamplingGroup) {
    this.activeGroup = group
    this.tierForm = { groupId: group.id, tier: group.tier, reason: group.reason }
    this.tierDialog = true
  }

  submitTier() {
    if (!this.activeGroup) return
    this.store.dispatch(A.proposeTier({
      groupId: this.activeGroup.id, tier: this.tierForm.tier, reason: this.tierForm.reason, actor: this.actor,
    }))
    this.tierDialog = false
  }

  submitDefect() {
    const [method, report] = (this.defectForm.report || 'MT · 手工记录').split('·').map((s) => s.trim())
    this.store.dispatch(A.recordDefect({
      weldId: this.defectForm.weldId, defectType: this.defectForm.type, level: this.defectForm.level,
      length: this.defectForm.length, method: method || 'UT', report: report || this.defectForm.report,
    }))
    this.defectDialog = false
  }

  tierSeverity(tier: SampleTier): Severity { return tier === '加严' ? 'danger' : tier === '正常' ? 'warn' : 'success' }
  ratioOf(tier: SampleTier): number { return TIER_POLICIES[tier].ratio }
  planSeverity(state: string): Severity {
    return state === '已完成' ? 'success' : state === '执行中' ? 'info' : state === '已失效' ? 'danger' : 'warn'
  }
  pickSeverity(state: SamplePick['state']): Severity {
    switch (state) {
      case '已出报告': return 'success'
      case '执行中': return 'info'
      case '已排程': return 'warn'
      case '原批次保留': return 'secondary'
      case '已失效': return 'danger'
      default: return 'warn'
    }
  }
}
