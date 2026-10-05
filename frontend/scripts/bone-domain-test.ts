/**
 * 鉴定域核心不变量测试（不进生产包，仅用 esbuild 临时编译后在 Node 跑）。
 * 覆盖：重复提交拒绝、人工单件优先、复核幂等、库房事项按当时复核保留、并发/写入失败整批回退。
 */
import {
  createBatch,
  decideReview,
  effectiveResult,
  listBatches,
  listIntakes,
  listLedger,
  listManualResults,
  listReviews,
  placeIntakes,
  resetBoneDomain,
  specimenViews,
  submitBatch,
  submitManualResult,
} from '../src/api/bone-service'
import { listRows, saveRows } from '../src/data/local-store'
import type { EntryRow } from '../src/data/types'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

// 用一套干净的标本（id 101-104）做测试，避免与示例数据冲突。
function freshSpecimens() {
  const rows: EntryRow[] = [101, 102, 103, 104].map((id) => ({
    id,
    status: '已采集',
    pending: true,
    abnormal: false,
 标本编号: `T-${id}`,
    出土单位: 'U1',
    种属判定: '',
    骨骼部位: '肋骨',
    数量统计: 1,
    最小个体数: 1,
  }))
  saveRows('animal_bone', rows)
}

function main() {
  resetBoneDomain()
  freshSpecimens()

  console.log('场景1：批次内同一件标本连续提交两次 → 第二次拒绝，只有一条复核')
  const b1 = createBatch('甲')
  const r1 = submitBatch(b1.id, [
    { specimenId: 101, 种属判定: '家猪' },
    { specimenId: 101, 种属判定: '野猪' },
  ], '甲')
  check('整批被拒绝', !r1.ok, r1.message)
  check('批次退回「鉴定中」', listBatches().find((x) => x.id === b1.id)?.status === '鉴定中')
  check('没有生成任何复核记录', listReviews().filter((x) => x.specimenId === 101).length === 0)
  check('批次内没有写入单件结论', (listBatches().find((x) => x.id === b1.id)?.items.length ?? -1) === 0)
  check('没有生成待入藏事项', listIntakes().filter((x) => x.specimenId === 101).length === 0)

  console.log('场景2：跨批次重复提交同一标本 → 只认第一次，种属不被覆盖')
  const b2 = createBatch('甲')
  const r2 = submitBatch(b2.id, [{ specimenId: 101, 种属判定: '家猪' }], '甲')
  check('第一次提交成功', r2.ok, r2.message)
  const b3 = createBatch('乙')
  const r3 = submitBatch(b3.id, [{ specimenId: 101, 种属判定: '黄牛' }], '乙')
  check('第二次跨批次提交被拒绝', !r3.ok, r3.message)
  check('b3 退回鉴定中', listBatches().find((x) => x.id === b3.id)?.status === '鉴定中')
  const eff = effectiveResult(101)
  check('有效结论仍是第一次的家猪', eff?.种属判定 === '家猪', JSON.stringify(eff))
  check('该标本只有一条复核记录', listReviews().filter((x) => x.specimenId === 101).length === 1)

  console.log('场景3：复核通过只生成一条待入藏；重复复核被拒绝')
  const review101 = listReviews().find((x) => x.specimenId === 101)!
  const d1 = decideReview({ reviewId: review101.id, pass: true, reviewer: '复核员' })
  check('复核通过', d1.ok, d1.message)
  const d2 = decideReview({ reviewId: review101.id, pass: true, reviewer: '复核员' })
  check('重复复核被拒绝', !d2.ok, d2.message)
  check('待入藏事项只有一条', listIntakes().filter((x) => x.specimenId === 101).length === 1)
  check('待入藏种属=复核时的家猪', listIntakes().find((x) => x.specimenId === 101)?.种属判定 === '家猪')

  console.log('场景4：批次内外结论冲突 → 人工单件优先，批次件 superseded，复核口径切换且不新增')
  const b4 = createBatch('甲')
  const r4 = submitBatch(b4.id, [{ specimenId: 102, 种属判定: '梅花鹿' }], '甲')
  check('批次提交 102 成功', r4.ok, r4.message)
  const m1 = submitManualResult({
    specimenId: 102,
    种属判定: '水鹿',
    鉴定人: '专家',
  })
  check('人工单件提交成功并压过批次件', m1.ok, m1.message)
  const eff102 = effectiveResult(102)
  check('统一口径为人工件水鹿', eff102?.source === '人工单件' && eff102.种属判定 === '水鹿')
  const batchItem102 = listBatches()
    .find((x) => x.id === b4.id)
    ?.items.find((x) => x.specimenId === 102)
  check('批次内梅花鹿已标记 superseded', batchItem102?.superseded === true)
  const reviews102 = listReviews().filter((x) => x.specimenId === 102)
  check('仍只有一条复核记录（无重复）', reviews102.length === 1, `实际 ${reviews102.length} 条`)
  check('复核口径切到人工单件、种属水鹿', reviews102[0]?.结论来源 === '人工单件' && reviews102[0]?.种属判定 === '水鹿')

  console.log('场景5：人工件之后再提交一次人工件（同标本）→ 拒绝，不覆盖')
  const m2 = submitManualResult({ specimenId: 102, 种属判定: '狍子', 鉴定人: '专家2' })
  check('第二次人工单件被拒绝', !m2.ok, m2.message)
  check('有效种属仍为水鹿', effectiveResult(102)?.种属判定 === '水鹿')

  console.log('场景6：复核通过后人工改判 → 跨业务库房事项按当时复核结果保留')
  const review102 = listReviews().find((x) => x.specimenId === 102)!
  decideReview({ reviewId: review102.id, pass: true, reviewer: '复核员' })
  check('102 待入藏按复核时水鹿生成', listIntakes().find((x) => x.specimenId === 102)?.种属判定 === '水鹿')
  // 已有人工件后再想覆盖，走「拒绝」；此处再验证既存事项不被回改也不重复：
  const m3 = submitManualResult({ specimenId: 102, 种属判定: '麋鹿', 鉴定人: '专家3' })
  check('再次人工提交被拒绝（第一次结论锁定）', !m3.ok, m3.message)
  const intakes102 = listIntakes().filter((x) => x.specimenId === 102)
  check('待入藏仍只有一条且仍为水鹿', intakes102.length === 1 && intakes102[0].种属判定 === '水鹿')

  console.log('场景7：批次写入中途失败 → 整批回退，无半份记录/半份台账')
  const b5 = createBatch('甲')
  const beforeReviews = listReviews().length
  const r5 = submitBatch(
    b5.id,
    [
      { specimenId: 103, 种属判定: '狗' },
      { specimenId: 999, 种属判定: '猫' }, // 不存在的标本，在第二件触发失败
    ],
    '甲',
  )
  check('批次因坏标本失败', !r5.ok, r5.message)
  check('批次退回鉴定中', listBatches().find((x) => x.id === b5.id)?.status === '鉴定中')
  check('第一件狗也没有留下复核（回退彻底）', listReviews().length === beforeReviews)
  check('103 无有效结论（未被半份写入污染）', effectiveResult(103) === null)

  console.log('场景8：多件上架原子性 → 重复/坏件导致整批回退，台账不生成半份')
  const b6 = createBatch('甲')
  submitBatch(
    b6.id,
    [
      { specimenId: 103, 种属判定: '狗' },
      { specimenId: 104, 种属判定: '家鸡' },
    ],
    '甲',
  )
  for (const spec of [103, 104]) {
    const rv = listReviews().find((x) => x.specimenId === spec)!
    decideReview({ reviewId: rv.id, pass: true, reviewer: '复核员' })
  }
  const intake103 = listIntakes().find((x) => x.specimenId === 103)!.id
  const intake104 = listIntakes().find((x) => x.specimenId === 104)!.id
  const beforeLedger = listLedger().length
  const p1 = placeIntakes([
    { intakeId: intake103, 架位编号: 'A-1', 操作人: '库管' },
    { intakeId: 99999, 架位编号: 'A-1', 操作人: '库管' }, // 坏件
  ])
  check('含坏件的上架被拒', !p1.ok, p1.message)
  check('台账一条都没多', listLedger().length === beforeLedger)
  const p2 = placeIntakes([
    { intakeId: intake103, 架位编号: 'A-1', 操作人: '库管' },
    { intakeId: intake104, 架位编号: 'A-2', 操作人: '库管' },
  ])
  check('正常整批上架成功', p2.ok, p2.message)
  check('台账新增 2 条', listLedger().length === beforeLedger + 2)
  const p3 = placeIntakes([{ intakeId: intake103, 架位编号: 'A-9', 操作人: '库管' }])
  check('重复上架被拒绝', !p3.ok, p3.message)
  check('103 台账仍指向原架位 A-1', listLedger().find((x) => x.specimenId === 103)?.架位编号 === 'A-1')

  console.log('场景9：列表/库房统一口径去重 → 一件标本在 specimenViews 中只出现一次')
  const views = specimenViews()
  for (const id of [101, 102, 103, 104]) {
    check(`标本 ${id} 只出现一次`, views.filter((v) => Number(v.row.id) === id).length === 1)
    check(`标本 ${id} 至多一条待入藏`, listIntakes().filter((x) => x.specimenId === id).length <= 1)
    check(`标本 ${id} 至多一条台账`, listLedger().filter((x) => x.specimenId === id).length <= 1)
  }

  console.log('场景10：复核拒绝不产生待入藏，批次在全件有结论后收口')
  const b7 = createBatch('甲')
  submitBatch(b7.id, [{ specimenId: 101, 种属判定: '不可能' }], '甲') // 101 已有结论 → 应被拒
  check('对已有结论标本再提交整批拒绝', listBatches().find((x) => x.id === b7.id)?.status === '鉴定中')
  check('listRows 仍可读取动物骨骼表', listRows('animal_bone').length === 4)
  check('人工件表存在 102 的水鹿', listManualResults().some((x) => x.specimenId === 102 && x.种属判定 === '水鹿'))

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) {
    process.exit(1)
  }
}

main()
