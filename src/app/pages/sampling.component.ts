import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { Store } from '@ngrx/store'
import { FormsModule } from '@angular/forms'
import { TableModule } from 'primeng/table'
import { TagModule } from 'primeng/tag'
import { ButtonModule } from 'primeng/button'
import { InputNumberModule } from 'primeng/inputnumber'
import { WeldState } from '../store/weld.reducer'
import * as A from '../store/weld.actions'
import type { QueueItem, SamplingGroup, SamplingLevel, Weld } from '../types'

@Component({
  selector: 'app-sampling',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, InputNumberModule],
  template: `
    <main class="page">
      <div class="page-head">
        <div>
          <p class="eyebrow">分级抽检 · 重算 · 排队 · 并发</p>
          <h1>焊缝分级抽检</h1>
          <p>缺陷等级或返修次数一变，按图纸与接头类型重算组内层级；未开始计划失效补样，已出报告留在原批次；检验员与超声仪容量不足则排队顺延。</p>
        </div>
        <p-button label="一键重算全部" icon="pi pi-refresh" (onClick)="recalcAll()" />
      </div>

      <div class="grid-4">
        <article class="card metric"><span>抽检组</span><strong>{{ state.groups.length }}</strong><small>图纸 + 接头类型</small></article>
        <article class="card metric"><span>待确认 / 差异</span><strong class="warning">{{ pendingCount }}</strong><small>重算后待确认或两人修改冲突</small></article>
        <article class="card metric"><span>容量缺口</span><strong class="danger">{{ gapCount }}</strong><small>条样本排不进当日</small></article>
        <article class="card metric"><span>已顺延</span><strong>{{ postponedCount }}</strong><small>条样本排队至后续日期</small></article>
      </div>

      <section class="card capacity-card">
        <h2 class="panel-title">每日容量配置</h2>
        <div class="capacity-row">
          <label>现场检验员（人/天）
            <p-inputnumber [(ngModel)]="capacity.inspectorDaily" [min]="1" [max]="20" (ngModelChange)="applyCapacity()" />
          </label>
          <label>超声仪（台/天）
            <p-inputnumber [(ngModel)]="capacity.utDaily" [min]="1" [max]="20" (ngModelChange)="applyCapacity()" />
          </label>
          <span class="cap-hint">超声检测日有效容量 = min(检验员, 超声仪) = <b>{{ effectiveCap }}</b> 条</span>
        </div>
      </section>

      <div class="sampling-grid">
        <div class="groups-col">
          <section class="card group-card" *ngFor="let group of state.groups">
            <div class="group-head">
              <div>
                <h3>{{ group.drawing }} <span class="joint">/ {{ group.joint }}</span></h3>
                <small class="muted">{{ group.id }} · 版本 v{{ group.version }} · 上次确认 {{ group.confirmedLevel }}</small>
              </div>
              <div class="badges">
                <p-tag [value]="group.level" [severity]="levelSeverity(group.level)" />
                <p-tag [value]="group.status" [severity]="statusSeverity(group.status)" />
              </div>
            </div>

            <div class="group-stats">
              <span>组内焊缝 <b>{{ group.weldIds.length }}</b></span>
              <span>已采用 <b class="adopted">{{ group.adoptedWeldIds.length }}</b>（不重复抽取）</span>
              <span>计划样本 <b>{{ group.plannedWeldIds.length }}</b></span>
              <span>失效计划 <b class="danger">{{ group.invalidatedPlanIds.length }}</b></span>
            </div>

            <div class="weld-mini">
              <div class="weld-row" *ngFor="let weld of weldsInGroup(group)">
                <span class="weld-id">{{ weld.id }}</span>
                <span class="weld-defects">
                  <ng-container *ngIf="weld.defects.length; else noDefect">
                    <i *ngFor="let d of weld.defects" class="defect-chip" [class]="'lv-' + d.level">{{ d.type }} {{ d.level }} · 返修 {{ weld.repairs }}</i>
                  </ng-container>
                  <ng-template #noDefect><span class="muted">无缺陷 · 返修 {{ weld.repairs }}</span></ng-template>
                </span>
                <p-tag [value]="weld.status" [severity]="weld.status === '合格' || weld.status === '已关闭' ? 'success' : weld.status === '返修中' ? 'danger' : 'warn'" />
              </div>
            </div>

            <p class="gap-note" *ngIf="group.gapNote"><i class="pi pi-exclamation-triangle"></i> {{ group.gapNote }}</p>

            <div class="diff-box" *ngIf="group.status === '差异待处理' && group.pendingDiff">
              <b>后到差异待处理</b>
              <p>{{ group.pendingDiff.actor}} 提交层级 <b>{{ group.pendingDiff.level }}</b>（基线 v{{ group.pendingDiff.baseVersion }}），先到结果 <b>{{ group.level }}</b> 已保留。</p>
              <div class="diff-actions">
                <p-button label="采纳后到差异" size="small" severity="warn" (onClick)="resolveDiff(group, true)" />
                <p-button label="保留先到结果" size="small" severity="secondary" (onClick)="resolveDiff(group, false)" />
              </div>
            </div>

            <div class="group-actions">
              <p-button label="重算并补样" icon="pi pi-refresh" size="small" (onClick)="recalc(group)" />
              <p-button label="确认层级" icon="pi pi-check" size="small" severity="success" [disabled]="group.status === '已确认'" (onClick)="commit(group)" />
              <p-button label="恢复确认层级" icon="pi pi-undo" size="small" severity="secondary" (onClick)="restore(group)" />
              <p-button label="模拟两人同时修改" icon="pi pi-users" size="small" severity="help" (onClick)="simulateConcurrent(group)" />
              <p-button label="按容量排期" icon="pi pi-calendar" size="small" severity="info" (onClick)="schedule(group)" />
            </div>
          </section>
        </div>

        <aside class="card queue-col">
          <h2 class="panel-title">排队与缺口</h2>
          <p class="muted" *ngIf="!state.queue.length">暂无排期样本。点击组内「按容量排期」或「重算并补样」生成队列。</p>
          <div class="queue-day" *ngFor="let day of queueDays">
            <div class="day-head">
              <b>{{ day.day }}</b>
              <span class="muted">{{ day.items.length }} 条</span>
            </div>
            <div class="queue-items">
              <span class="queue-item" *ngFor="let item of day.items" [class]="item.status">
                {{ item.weldId }}
                <small *ngIf="item.gap" class="gap-tag" [title]="item.gap">缺口顺延</small>
              </span>
            </div>
          </div>
          <div class="gap-list" *ngIf="gaps.length">
            <h3 class="gap-title">容量缺口明细</h3>
            <p class="gap-line" *ngFor="let gap of gaps"><i class="pi pi-exclamation-circle"></i> {{ gap }}</p>
          </div>
        </aside>
      </div>
    </main>
  `,
  styles: [
    '.capacity-card{margin-bottom:16px}.capacity-row{display:flex;gap:18px;align-items:flex-end;flex-wrap:wrap}.capacity-row label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#475467}.cap-hint{font-size:13px;color:#7a8798}.cap-hint b{color:#2563eb}',
    '.sampling-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(320px,.7fr);gap:16px;align-items:start}',
    '.group-card{margin-bottom:14px}.group-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.group-head h3{margin:0;font-size:16px}.group-head .joint{color:#7a8798;font-weight:500}.badges{display:flex;gap:6px;flex-shrink:0}',
    '.group-stats{display:flex;gap:16px;flex-wrap:wrap;margin:10px 0;font-size:13px;color:#475467}.group-stats b{color:#0f172a}.group-stats .adopted{color:#16a34a}.group-stats .danger{color:#dc2626}',
    '.weld-mini{border:1px solid #edf0f5;border-radius:8px;overflow:hidden}.weld-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid #f2f4f7;font-size:13px}.weld-row:last-child{border-bottom:none}.weld-id{font-weight:700;min-width:52px}.weld-defects{flex:1;display:flex;gap:6px;flex-wrap:wrap}.defect-chip{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:2px 7px;border-radius:4px;font-size:12px}.defect-chip.lv-Ⅰ级{background:#f0fdf4;border-color:#bbf7d0;color:#15803d}.defect-chip.lv-Ⅱ级{background:#fffbeb;border-color:#fde68a;color:#b45309}.muted{color:#7a8798;font-size:12px}',
    '.gap-note{margin:10px 0 0;padding:8px 10px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px;font-size:13px;color:#92400e}.gap-note i{margin-right:4px}',
    '.diff-box{margin:10px 0;padding:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px}.diff-box p{margin:4px 0 0;font-size:13px}.diff-actions{display:flex;gap:8px;margin-top:8px}',
    '.group-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
    '.queue-col{position:sticky;top:84px}.queue-day{margin-bottom:12px}.day-head{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #edf0f5;font-size:13px}.queue-items{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.queue-item{background:#f1f5f9;padding:4px 8px;border-radius:4px;font-size:12px}.queue-item.已顺延{background:#fef3c7;color:#92400e}.gap-tag{color:#dc2626;margin-left:4px}.gap-list{margin-top:14px;padding-top:12px;border-top:1px solid #edf0f5}.gap-title{margin:0 0 6px;font-size:13px}.gap-line{font-size:12px;color:#92400e;margin:4px 0}',
    '@media(max-width:960px){.sampling-grid{grid-template-columns:1fr}.queue-col{position:static}}',
  ],
})
export class SamplingComponent {
  private readonly store = inject(Store<{ welds: WeldState }>)
  state!: WeldState
  capacity = { inspectorDaily: 6, utDaily: 4 }

  constructor() {
    this.store.select('welds').subscribe((state) => {
      this.state = state
      this.capacity = { ...state.capacity }
    })
  }

  get effectiveCap() {
    return Math.min(this.capacity.inspectorDaily, this.capacity.utDaily)
  }

  get pendingCount() {
    return (this.state?.groups ?? []).filter((g) => g.status !== '已确认').length
  }

  get gapCount() {
    return (this.state?.queue ?? []).filter((q) => q.gap).length
  }

  get postponedCount() {
    return (this.state?.queue ?? []).filter((q) => q.status === '已顺延').length
  }

  get queueDays() {
    const map = new Map<string, { day: string; items: QueueItem[] }>()
    for (const item of this.state?.queue ?? []) {
      if (!map.has(item.day)) map.set(item.day, { day: item.day, items: [] })
      map.get(item.day)!.items.push(item)
    }
    return [...map.values()].sort((a, b) => a.day.localeCompare(b.day))
  }

  get gaps() {
    return (this.state?.groups ?? []).map((g) => g.gapNote).filter(Boolean) as string[]
  }

  weldsInGroup(group: SamplingGroup): Weld[] {
    return group.weldIds.map((id) => this.state.welds.find((w) => w.id === id)!).filter(Boolean)
  }

  levelSeverity(level: SamplingLevel) {
    return level === '全检' ? 'danger' : level === '加严' ? 'warn' : 'success'
  }

  statusSeverity(status: string) {
    return status === '已确认' ? 'success' : status === '差异待处理' ? 'danger' : 'warn'
  }

  applyCapacity() {
    this.store.dispatch(A.setCapacity({ capacity: { ...this.capacity } }))
  }

  recalc(group: SamplingGroup) {
    this.store.dispatch(A.recalcGroup({ groupId: group.id }))
  }

  recalcAll() {
    this.store.dispatch(A.recalcAllGroups())
  }

  commit(group: SamplingGroup) {
    this.store.dispatch(A.commitGroupLevel({ groupId: group.id, level: group.level, actor: '当前审核人', baseVersion: group.version }))
  }

  restore(group: SamplingGroup) {
    this.store.dispatch(A.restoreGroupLevel({ groupId: group.id }))
  }

  resolveDiff(group: SamplingGroup, adopt: boolean) {
    this.store.dispatch(A.resolveGroupDiff({ groupId: group.id, adopt }))
  }

  schedule(group: SamplingGroup) {
    const start = new Date()
    start.setDate(start.getDate() + 1)
    this.store.dispatch(A.scheduleGroup({ groupId: group.id, startDate: start.toISOString().slice(0, 10), method: 'UT + MT' }))
  }

  /** 模拟两人同时修改同一层级：先到结果保留，后到内容作为差异待处理 */
  simulateConcurrent(group: SamplingGroup) {
    const base = group.version
    this.store.dispatch(A.commitGroupLevel({ groupId: group.id, level: '加严', actor: '审核员甲', baseVersion: base }))
    this.store.dispatch(A.commitGroupLevel({ groupId: group.id, level: '全检', actor: '审核员乙', baseVersion: base }))
  }
}
