import { recomputeSampling, deriveTier, groupIdOf } from '../src/app/domain/sampling'
import { TierConcurrencyBoard } from '../src/app/domain/tier-sync'

let pass = 0, fail = 0
const assert = (cond, label) => { if (cond) { pass++; console.log('  ✓', label) } else { fail++; console.log('  ✗ FAIL:', label) } }

// ---- fixture ----
const W = (id, drawing, joint, status, repairs, defects = []) =>
  ({ id, drawing, component: 'C', joint, method: 'UT', welder: 'x', qualification: 'q', qualificationValid: true, inspectionRatio: 20, requiredRatio: 20, status, x: 0, y: 0, repairs, defects })
const D = (level) => ({ id: 'd' + Math.random(), position: 10, type: '夹渣', length: 5, level, method: 'UT', report: 'r' })

console.log('\n[1] 层级推导')
assert(deriveTier([W('a','DW','角焊缝','待检测',0)]).tier === '放宽', '无缺陷 → 放宽')
assert(deriveTier([W('a','DW','角焊缝','待检测',1)]).tier === '正常', '返修1次 → 正常')
assert(deriveTier([W('a','DW','角焊缝','待检测',0,[D('Ⅱ级')])]).tier === '正常', 'Ⅱ级缺陷 → 正常')
assert(deriveTier([W('a','DW','角焊缝','待检测',2)]).tier === '加严', '返修2次 → 加严')
assert(deriveTier([W('a','DW','角焊缝','待检测',0,[D('Ⅲ级')])]).tier === '加严', 'Ⅲ级 → 加严')
assert(deriveTier([W('a','DW','角焊缝','待检测',0,[D('Ⅰ级')]),W('b','DW','角焊缝','待检测',0,[D('Ⅳ级')])]).tier === '加严', '组内取最差等级 Ⅳ级 → 加严')

// ---- bootstrap ----
const welds0 = [
  W('W1','DW','角焊缝','待检测',0), W('W2','DW','角焊缝','待检测',0),
  W('W3','DW','角焊缝','待检测',0), W('W4','DW','角焊缝','待检测',0),
  W('W5','DW','角焊缝','待检测',0),
  W('J1','DW','对接焊缝','待复检',2,[D('Ⅱ级')]), W('J2','DW','对接焊缝','待检测',0),
]
const gid = groupIdOf('DW','角焊缝')
const caps = [{date:'2026-10-05',inspectorCapacity:1,instrumentCapacity:1},{date:'2026-10-06',inspectorCapacity:1,instrumentCapacity:1}]
const opts = { initial:true, startDate:'2026-10-05', inspectors:['I1'], instruments:['M1'] }

let r = recomputeSampling({ welds:welds0, plans:[], groups:[], picks:[], capacities:caps, gaps:[] }, opts)
// 放宽 10% of 5 = ceil(0.5)=1；对接加严 100% of 2 = 2
assert(r.groups.find(g=>g.id===gid).tier === '放宽', '初始：角焊缝组放宽')
assert(r.groups.find(g=>g.id===groupIdOf('DW','对接焊缝')).tier === '加严', '初始：对接组加严（2次返修）')
const initialPicks = r.picks.filter(p=>p.groupId===gid)
assert(initialPicks.length === 1 && initialPicks.every(p=>p.adopted), '放宽组按比例抽 1 个且标记已采用')
assert(r.picks.filter(p=>p.groupId===groupIdOf('DW','对接焊缝')).length === 2, '加严组 100% 抽 2 个')
assert(r.picks.some(p=>p.gap && p.scheduledDate==='2026-10-07'), '第3个样本超出两天容量 → 缺口并顺延 10-07')
assert(r.gaps.length >= 1 && r.gaps.every(g=>g.resource==='检验员'||g.resource==='超声仪'), '缺口写明资源（检验员/超声仪）')
const autoPlans = r.plans.filter(p=>p.state==='待执行')
assert(autoPlans.length === 2, '已排程样本自动生成补样计划（每天1个）')

// ---- 缺陷升级触发重算：未开始计划失效、样本回池补抽、已采用不重复 ----
console.log('\n[2] 缺陷等级变更 → 重算/失效/补样/不重复')
const opts2 = { ...opts, inspectors:['I1','I2'], instruments:['M1','M2'] }
// 独立基线：放宽组 W1 已进入一份“待执行”计划
const plans0 = [{ id:'P0', date:'2026-10-05', method:'UT', weldIds:['W1'], inspector:'I1', state:'待执行' }]
const rb = recomputeSampling({ welds:welds0, plans:plans0.map(p=>({...p,weldIds:[...p.weldIds]})), groups:[], picks:[], capacities:caps, gaps:[] }, opts2)
const seed = [{
  id:'seed-P0', weldId:'W1', groupId:gid, tier:'放宽', batchNo:'B0', revision:1,
  state:'已排程', adopted:true, planId:'P0', scheduledDate:'2026-10-05', inspector:'I1', instrument:'M1',
}]
const rb2 = recomputeSampling({ welds:welds0, plans:plans0.map(p=>({...p,weldIds:[...p.weldIds]})), groups:rb.groups.map(g=>({...g,weldIds:[...g.weldIds]})), picks:seed, capacities:caps, gaps:[] }, opts2)
const welds1 = welds0.map(w => w.id==='W1' ? { ...w, defects:[D('Ⅲ级')] } : w)
let r2 = recomputeSampling({ welds:welds1, plans:rb2.plans.map(p=>({...p,weldIds:[...p.weldIds]})), groups:rb2.groups.map(g=>({...g,weldIds:[...g.weldIds]})), picks:rb2.picks.map(p=>({...p})), capacities:caps, gaps:rb2.gaps.map(g=>({...g})) }, { ...opts2, initial:false })
const g1 = r2.groups.find(g=>g.id===gid)
assert(g1.tier === '加严' && g1.revision === 2 && g1.status === '待确认', '角焊缝 Ⅲ级 → 加严 rev2 待确认')
const w1Active = r2.picks.filter(p=>p.weldId==='W1' && p.state!=='已失效')
assert(w1Active.length === 1, '同一条焊缝同一批次只有一个有效样本（不重复抽取；旧样本保留失效痕迹）')
const invalidatedPlans = r2.plans.filter(p=>p.state==='已失效')
assert(invalidatedPlans.length >= 1, '含未开始样本的待执行计划失效')
assert(r2.plans.some(p=>p.replacedBy), '失效计划记录替代计划（补入新样本）')
assert(r2.events.some(e=>e.action==='补入新样本'), '审计事件：补入新样本')
// 加严 100% of 5 → 目标5，原W1样本回池，需要补到5
const livePicks = r2.picks.filter(p=>p.groupId===gid && p.state!=='已失效')
assert(livePicks.length === 5, '加严后组内补样到 100%（5条）')
const weldIdsPicked = livePicks.map(p=>p.weldId)
assert(new Set(weldIdsPicked).size === weldIdsPicked.length, '样本焊缝不重复')
assert(r2.picks.every(p=> livePicks.includes(p) || p.groupId!==gid || p.state==='已失效'), '回池旧样本标记已失效')

// ---- 执行中 / 已出报告留在原批次 ----
console.log('\n[3] 执行中/已出报告留在原批次')
const seeded = [
  { id:'PA', date:'2026-10-05', method:'UT', weldIds:['J1'], inspector:'I1', state:'执行中' },
  { id:'PB', date:'2026-10-05', method:'UT', weldIds:['J2'], inspector:'I1', state:'待执行' },
]
// 先建 rev1 加严组样本挂到计划
const rj = recomputeSampling({ welds:welds0, plans:seeded.map(p=>({...p,weldIds:[...p.weldIds]})), groups:[], picks:[], capacities:caps, gaps:[] }, opts)
const jgid = groupIdOf('DW','对接焊缝')
// 模拟 bootstrap：为存量计划补样本
const seedPicks = []
for (const p of seeded) for (const wid of p.weldIds) seedPicks.push({
  id:'seed-'+p.id+wid, weldId:wid, groupId:jgid, tier:'加严', batchNo:'B0', revision:1,
  state: p.state==='执行中'?'执行中':'已排程', adopted:true, planId:p.id, scheduledDate:p.date, inspector:p.inspector, instrument:'M1',
})
let rj2 = recomputeSampling({ welds:welds0, plans:seeded.map(p=>({...p,weldIds:[...p.weldIds]})), groups:rj.groups.map(g=>({...g,weldIds:[...g.weldIds]})), picks:seedPicks, capacities:caps, gaps:[] }, opts)
// 现在数据再恶化：J2 也返修2次 → 组仍加严，不触发；改为先正常后加严场景：新组 rev1 正常
const weldsNormal = welds0.map(w => ({ ...w, repairs:0, defects:[] }))
// 用角焊缝组做实验：rev1 放宽并把 W1 挂入待执行计划、W2 挂入执行中计划
const plans2 = [
  { id:'P-PENDING', date:'2026-10-05', method:'UT', weldIds:['W1'], inspector:'I1', state:'待执行' },
  { id:'P-RUNNING', date:'2026-10-05', method:'UT', weldIds:['W2'], inspector:'I2', state:'执行中' },
]
const rn = recomputeSampling({ welds:weldsNormal, plans:plans2.map(p=>({...p,weldIds:[...p.weldIds]})), groups:[], picks:[], capacities:caps, gaps:[] }, opts)
const sp = []
for (const p of plans2) for (const wid of p.weldIds) sp.push({
  id:'s-'+p.id, weldId:wid, groupId:gid, tier:'放宽', batchNo:'B0', revision:1,
  state: p.state==='执行中'?'执行中':'已排程', adopted:true, planId:p.id, scheduledDate:p.date, inspector:p.inspector, instrument:'M1',
})
let rn2 = recomputeSampling({ welds:weldsNormal, plans:plans2.map(p=>({...p,weldIds:[...p.weldIds]})), groups:rn.groups.map(g=>({...g,weldIds:[...g.weldIds]})), picks:sp, capacities:caps, gaps:[] }, opts)
const weldsUp = weldsNormal.map(w => w.id==='W3' ? { ...w, defects:[D('Ⅲ级')] } : w)
let r3 = recomputeSampling({ welds:weldsUp, plans:rn2.plans.map(p=>({...p,weldIds:[...p.weldIds]})), groups:rn2.groups.map(g=>({...g,weldIds:[...g.weldIds]})), picks:rn2.picks.map(p=>({...p})), capacities:caps, gaps:rn2.gaps.map(g=>({...g})) }, { ...opts, initial:false })
const w1pick = r3.picks.find(p=>p.weldId==='W1')
const w2pick = r3.picks.find(p=>p.weldId==='W2')
assert(r3.plans.find(p=>p.id==='P-PENDING').state==='已失效', '未开始计划 P-PENDING 失效')
assert(w1pick.state==='已失效' && w1pick.adopted===false, '待执行计划样本回池（adopted 复位）')
assert(r3.plans.find(p=>p.id==='P-RUNNING').state==='执行中', '执行中计划不失效')
assert(w2pick.state==='原批次保留', '执行中样本留在原批次')

// ---- 并发修改：先到保留，后到差异 ----
console.log('\n[4] 并发层级修改')
const board = new TierConcurrencyBoard()
const o1 = board.submit('G', 1, { actor:'陈锋', tier:'加严', reason:'r1' })
const o2 = board.submit('G', 1, { actor:'赵岚', tier:'放宽', reason:'r2' })
const o3 = board.submit('G', 1, { actor:'陈锋', tier:'正常', reason:'same actor resubmit' })
assert(o1.accepted, '先到提交接受')
assert(!o2.accepted && o2.conflict && o2.conflict.state==='待处理', '后到提交拒绝并产生待处理差异')
assert(o3.accepted, '同一人重复提交不产生差异')
const res = board.resolveConflict(o2.conflict.id, 'merge')
assert(res.adopt && res.adopt.tier==='放宽', '合并差异 → 采用后到内容')
const board2 = new TierConcurrencyBoard()
board2.submit('G',1,{actor:'陈锋',tier:'加严',reason:'r1'})
const c2 = board2.submit('G',1,{actor:'赵岚',tier:'放宽',reason:'r2'}).conflict
const res2 = board2.resolveConflict(c2.id,'ignore')
assert(res2 && !res2.adopt, '忽略差异 → 不采用后到内容')

// ---- 回滚恢复 override 生效；已采用样本不重复 ----
console.log('\n[5] 回滚与 override')
const overrideWorld = {
  welds:weldsUp, plans:r3.plans.map(p=>({...p,weldIds:[...p.weldIds]})),
  groups:r3.groups.map(g=>({...g,weldIds:[...g.weldIds]})), picks:r3.picks.map(p=>({...p})),
  capacities:caps, gaps:r3.gaps.map(g=>({...g})),
  tierOverrides:{ [gid]:{ tier:'正常', reason:'恢复到上次确认' } },
}
let r5 = recomputeSampling(overrideWorld, { ...opts, initial:false })
assert(r5.groups.find(g=>g.id===gid).tier === '正常', 'override：恢复上次确认的层级（正常）')

console.log(`\n结果: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
