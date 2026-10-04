import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { Store } from '@ngrx/store'
import { TableModule } from 'primeng/table'
import { TagModule } from 'primeng/tag'
import { ButtonModule } from 'primeng/button'
import { DialogModule } from 'primeng/dialog'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { SelectButtonModule } from 'primeng/selectbutton'
import { SelectModule } from 'primeng/select'
import { WeldState } from '../store/weld.reducer'
import * as A from '../store/weld.actions'
import type { DefectLevel, Weld } from '../types'

@Component({
  selector:'app-inspections', standalone:true, imports:[CommonModule,FormsModule,TableModule,TagModule,ButtonModule,DialogModule,InputTextModule,TextareaModule,SelectButtonModule,SelectModule],
  template:`
    <main class="page"><div class="page-head"><div><p class="eyebrow">NDT / 返修闭环</p><h1>检测计划与返修</h1><p>检测结果绑定缺陷位置、等级和报告；等级或返修次数一变，分级抽检立即按图纸 + 接头重算。</p></div><p-button label="录入检测结果" icon="pi pi-plus" (onClick)="dialog = true" /></div>
      <div class="grid-2"><section class="card"><h2 class="panel-title">批量检测计划</h2><p-table [value]="state.plans" [paginator]="true" [rows]="6"><ng-template #header><tr><th>计划编号</th><th>日期</th><th>方法</th><th>焊缝</th><th>检测人</th><th>状态</th></tr></ng-template><ng-template #body let-plan><tr [class.stale]="plan.state === '已失效'"><td>{{plan.id}}</td><td>{{plan.date}}</td><td>{{plan.method}}</td><td>{{plan.weldIds.join('、')}}</td><td>{{plan.inspector}}</td><td><p-tag [value]="plan.state" [severity]="plan.state === '已完成' ? 'success' : plan.state === '执行中' ? 'info' : plan.state === '已失效' ? 'danger' : 'warn'" /><small class="block" *ngIf="plan.state === '已失效'">层级变更失效<ng-container *ngIf="plan.replacedBy"> · 由 {{plan.replacedBy}} 补入</ng-container></small></td></tr></ng-template></p-table><p-button label="开始执行计划" icon="pi pi-play" styleClass="mt-3" (onClick)="startFirst()" /></section>
      <aside class="card"><h2 class="panel-title">返修状态流转（登记返修触发层级重算）</h2><div class="step" *ngFor="let weld of repairWelds"><div><b>{{weld.id}} · {{weld.component}}</b><small>{{weld.defects.length}} 个缺陷 · 已返修 {{weld.repairs}} 次<ng-container *ngIf="weld.repairs >= 2"> · 组内已加严</ng-container></small></div><p-tag [value]="weld.status" severity="warn" /><p-selectbutton [options]="['返修中','待复检','合格']" [ngModel]="weld.status" (ngModelChange)="advance(weld.id,$event)" /><p-button label="登记一次返修（次数 +1 重算）" size="small" severity="danger" text (onClick)="repair(weld)" /></div><p-button label="提交质量负责人审核" icon="pi pi-send" styleClass="w-full" /></aside></div>
      <section class="card mt-4"><h2 class="panel-title">检测结果与缺陷明细</h2><p-table [value]="defects" [paginator]="true" [rows]="8"><ng-template #header><tr><th>缺陷编号</th><th>焊缝</th><th>位置 / 长度</th><th>类型 / 等级</th><th>检测方法</th><th>报告</th><th>处置</th></tr></ng-template><ng-template #body let-item><tr><td>{{item.defect.id}}</td><td>{{item.weld.id}}<small class="block">{{item.weld.drawing}} · {{item.weld.joint}}</small></td><td>{{item.defect.position}}% · {{item.defect.length}}mm</td><td>{{item.defect.type}} · {{item.defect.level}}</td><td>{{item.defect.method}}</td><td>{{item.defect.report}}</td><td><p-button label="退回方案" severity="danger" size="small" text /><p-button label="确认复检合格" size="small" (onClick)="advance(item.weld.id,'合格')" /></td></tr></ng-template></p-table></section>
      <p-dialog header="录入检测结果" [(visible)]="dialog" [modal]="true" [style]="{width:'620px'}"><div class="form"><label>焊缝编号</label><p-select [options]="inspectable" [(ngModel)]="form.weldId" optionLabel="id" optionValue="id" placeholder="选择待检测焊缝" /><label>检测方法</label><select [(ngModel)]="form.method"><option>UT</option><option>MT</option><option>PT</option></select><label>缺陷位置（0–100%）</label><input pInputText type="number" [(ngModel)]="form.position" /><label>缺陷类型</label><input pInputText [(ngModel)]="form.type" placeholder="如：未熔合" /><label>缺陷等级（一变即重算组内层级）</label><p-select [options]="levelOptions" [(ngModel)]="form.level" optionLabel="name" optionValue="name" /><label>长度（mm）</label><input pInputText type="number" [(ngModel)]="form.length" /><label>报告编号与说明</label><textarea pTextarea [(ngModel)]="form.report" rows="3"></textarea></div><ng-template #footer><p-button label="取消" severity="secondary" (onClick)="dialog=false" /><p-button label="提交结果并重算" [disabled]="!form.weldId || !form.report" (onClick)="submit()" /></ng-template></p-dialog>
    </main>
  `,
  styles:[`.step{display:grid;grid-template-columns:1fr auto;gap:9px;padding:12px 0;border-bottom:1px solid #edf0f5}.step>div,.step small{display:block}.step small{color:#7a8798;margin-top:4px}.step p-selectbutton,.step .p-button{grid-column:1/-1}.form{display:grid;gap:9px}.form input,.form select,.form textarea{padding:9px;border:1px solid #cbd5e1;border-radius:6px;width:100%}.block{display:block;color:#7a8798;margin-top:3px}.stale{opacity:.6}.mt-3{margin-top:12px}.mt-4{margin-top:16px}`],
})
export class InspectionsComponent {
  private readonly store = inject(Store<{ welds: WeldState }>)
  state!: WeldState
  dialog = false
  levelOptions = (['Ⅰ级','Ⅱ级','Ⅲ级','Ⅳ级'] as DefectLevel[]).map((name) => ({ name }))
  form: { weldId: string; method: string; position: number; type: string; level: DefectLevel; length: number; report: string } = {
    weldId: '', method: 'UT', position: 42, type: '未熔合', level: 'Ⅲ级', length: 18, report: 'UT-2026-1005-08；按 NB/T 47013.3 评定。',
  }
  constructor() { this.store.select('welds').subscribe((state) => this.state = state) }
  get inspectable(): Weld[] { return (this.state?.welds ?? []).filter((w) => ['待检测','返修中','待复检'].includes(w.status)) }
  get repairWelds() { return (this.state?.welds ?? []).filter((item) => ['返修中','待复检'].includes(item.status)) }
  get defects() { return (this.state?.welds ?? []).flatMap((weld) => weld.defects.map((defect) => ({ weld, defect }))) }
  advance(id: string, status: unknown) { this.store.dispatch(A.advanceWeld({ id, status: status as '合格' })) }
  repair(weld: Weld) {
    this.store.dispatch(A.registerRepair({ weldId: weld.id, note: `现场判定返工${weld.repairs + 1}次` }))
  }
  startFirst() {
    const plan = (this.state?.plans ?? []).find((p) => p.state === '待执行')
    if (plan) this.store.dispatch(A.startPlan({ planId: plan.id }))
  }
  submit() {
    const [report] = this.form.report.split('；')
    this.store.dispatch(A.recordDefect({
      weldId: this.form.weldId, defectType: this.form.type, level: this.form.level,
      length: this.form.length, method: this.form.method, report: report.trim(),
    }))
    this.dialog = false
  }
}
