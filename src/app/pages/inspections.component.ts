import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { Store } from '@ngrx/store'
import { TableModule } from 'primeng/table'
import { TagModule } from 'primeng/tag'
import { ButtonModule } from 'primeng/button'
import { DialogModule } from 'primeng/dialog'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { SelectButtonModule } from 'primeng/selectbutton'
import { InputNumberModule } from 'primeng/inputnumber'
import { FormsModule } from '@angular/forms'
import { WeldState } from '../store/weld.reducer'
import * as A from '../store/weld.actions'
import type { Defect, DefectLevel } from '../types'

@Component({
  selector:'app-inspections', standalone:true, imports:[CommonModule,FormsModule,TableModule,TagModule,ButtonModule,DialogModule,InputTextModule,TextareaModule,SelectButtonModule,InputNumberModule],
  template:`
    <main class="page"><div class="page-head"><div><p class="eyebrow">NDT / 返修闭环</p><h1>检测计划与返修</h1><p>检测结果绑定缺陷位置、等级、照片、报告和返修方案；失败与复检不可无痕跳过。</p></div><p-button label="新增检测结果" icon="pi pi-plus" (onClick)="dialog = true" /></div>
      <div class="grid-2"><section class="card"><h2 class="panel-title">批量检测计划</h2><p-table [value]="state.plans" [paginator]="true" [rows]="6"><ng-template #header><tr><th>计划编号</th><th>日期</th><th>方法</th><th>焊缝</th><th>检测人</th><th>状态</th></tr></ng-template><ng-template #body let-plan><tr><td>{{plan.id}}</td><td>{{plan.date}}</td><td>{{plan.method}}</td><td>{{plan.weldIds.length}} 条</td><td>{{plan.inspector}}</td><td><p-tag [value]="plan.state" [severity]="plan.state === '已完成' ? 'success' : plan.state === '执行中' ? 'info' : 'warn'" /></td></tr></ng-template></p-table><p-button label="开始执行计划" icon="pi pi-play" styleClass="mt-3" /></section>
      <aside class="card"><h2 class="panel-title">返修状态流转</h2><div class="step" *ngFor="let weld of repairWelds"><div><b>{{weld.id}} · {{weld.component}}</b><small>{{weld.defects.length}} 个缺陷 · 已返修 {{weld.repairs}} 次</small></div><p-tag [value]="weld.status" severity="warn" /><p-selectbutton [options]="['返修中','待复检','合格']" [ngModel]="weld.status" (ngModelChange)="advance(weld.id,$event)" /><div class="repairs-row"><label>返修次数</label><p-inputnumber [ngModel]="weld.repairs" [min]="0" [max]="5" (ngModelChange)="changeRepairs(weld.id,$event)" /><span class="repairs-hint">次数一变即重算层级</span></div></div><p-button label="提交质量负责人审核" icon="pi pi-send" styleClass="w-full" /></aside></div>
      <section class="card mt-4"><h2 class="panel-title">检测结果与缺陷明细</h2><p-table [value]="defects" [paginator]="true" [rows]="8"><ng-template #header><tr><th>缺陷编号</th><th>焊缝</th><th>位置 / 长度</th><th>类型 / 等级</th><th>检测方法</th><th>报告</th><th>处置</th></tr></ng-template><ng-template #body let-item><tr><td>{{item.defect.id}}</td><td>{{item.weld.id}}</td><td>{{item.defect.position}}% · {{item.defect.length}}mm</td><td>{{item.defect.type}} · {{item.defect.level}}</td><td>{{item.defect.method}}</td><td>{{item.defect.report}}</td><td><p-button label="退回方案" severity="danger" size="small" text /><p-button label="确认复检" size="small" (onClick)="advance(item.weld.id,'合格')" /></td></tr></ng-template></p-table></section>
      <p-dialog header="录入检测结果" [(visible)]="dialog" [modal]="true" [style]="{width:'620px'}"><div class="form"><label>焊缝编号</label><input pInputText [(ngModel)]="form.weldId" /><label>检测方法</label><select [(ngModel)]="form.method"><option>UT</option><option>MT</option><option>PT</option></select><label>缺陷位置（0–100%）</label><input pInputText type="number" [(ngModel)]="form.position" /><label>缺陷类型</label><input pInputText [(ngModel)]="form.type" placeholder="如：未熔合" /><label>缺陷等级</label><select [(ngModel)]="form.level"><option *ngFor="let lv of levelOptions" [value]="lv">{{ lv }}</option></select><label>缺陷长度（mm）</label><input pInputText type="number" [(ngModel)]="form.length" /><label>报告编号与说明</label><textarea pTextarea [(ngModel)]="form.report" rows="4"></textarea><p class="form-hint">提交后将按图纸 + 接头类型重算抽检层级：高等级缺陷会加严至全检，未开始计划失效补样，已出报告留在原批次。</p></div><ng-template #footer><p-button label="取消" severity="secondary" (onClick)="dialog=false" /><p-button label="提交结果" [disabled]="!form.weldId || !form.report" (onClick)="submit()" /></ng-template></p-dialog>
    </main>
  `,
  styles:[`.step{display:grid;grid-template-columns:1fr auto;gap:9px;padding:12px 0;border-bottom:1px solid #edf0f5}.step>div,.step small{display:block}.step small{color:#7a8798;margin-top:4px}.step p-selectbutton{grid-column:1/-1}.form{display:grid;gap:9px}.form input,.form select,.form textarea{padding:9px;border:1px solid #cbd5e1;border-radius:6px;width:100%}.form-hint{font-size:12px;color:#7a8798;background:#f8fafc;padding:8px;border-radius:6px;margin:0}.repairs-row{grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:13px;color:#475467}.repairs-row label{color:#475467}.repairs-hint{color:#7a8798;font-size:12px}.mt-3{margin-top:12px}.mt-4{margin-top:16px}`],
})
export class InspectionsComponent {
  private readonly store = inject(Store<{ welds: WeldState }>)
  state!: WeldState
  dialog = false
  form = { weldId:'W-107', method:'UT', position:68, type:'未熔合', level:'Ⅲ级' as DefectLevel, length:18, report:'UT-2026-0929-08；按 NB/T 47013.3 评定。' }
  levelOptions: DefectLevel[] = ['Ⅰ级','Ⅱ级','Ⅲ级','Ⅳ级']
  constructor() { this.store.select('welds').subscribe((state) => this.state = state) }
  get repairWelds() { return (this.state?.welds ?? []).filter((item) => ['返修中','待复检'].includes(item.status)) }
  get defects() { return (this.state?.welds ?? []).flatMap((weld) => weld.defects.map((defect) => ({ weld, defect }))) }
  advance(id: string, status: string) { this.store.dispatch(A.advanceWeld({ id, status: status as never })) }
  changeRepairs(weldId: string, repairs: number) { this.store.dispatch(A.setRepairs({ weldId, repairs })) }
  submit() {
    const defect: Defect = {
      id: `D-${Date.now().toString().slice(-6)}`,
      position: Number(this.form.position),
      type: this.form.type,
      length: Number(this.form.length),
      level: this.form.level,
      method: this.form.method,
      report: this.form.report,
    }
    this.store.dispatch(A.recordDefect({ weldId: this.form.weldId, defect }))
    this.dialog = false
  }
}
