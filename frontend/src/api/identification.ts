import { listRows, transact } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 动物骨骼鉴定域：鉴定批次 → 单件提交 → 复核写入 → 库房待入藏事项（架位台账）。
// 动物骨骼列表页与库房页共用本文件的取数口径，重复出项只可能来自这一处，修一处即全修。
//
// 三条铁律：
// 1. 同一标本只认第一次有效结论，重复提交整体拒绝，种属判定一个字都不动；
// 2. 批次内外结论冲突时人工单件结论优先；
// 3. 复核记录、待入藏事项、批次状态、标本状态在一个事务里落库，
//    写入失败全部回滚，批次退回「待复核」，不留半份记录。

const SPECIMEN_KEY = 'animal_bone'
const BATCH_KEY = 'animal_bone_batch'
const BATCH_ITEM_KEY = 'animal_bone_batch_item'
const REVIEW_KEY = 'animal_bone_review'
const INTAKE_KEY = 'storage_intake'

const BATCH_PENDING = '待复核'
const BATCH_REVIEWED = '已复核'

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

// ---- 共享取数口径：动物骨骼列表页与库房页都从这里取数 ----

export function listBatches(): EntryRow[] {
  return listRows(BATCH_KEY)
}

export function listBatchItems(): EntryRow[] {
  return listRows(BATCH_ITEM_KEY)
}

export function listReviews(): EntryRow[] {
  return listRows(REVIEW_KEY)
}

export function listStorageIntakes(): EntryRow[] {
  return listRows(INTAKE_KEY)
}

// 同一标本的有效结论只认第一次：已复核的以复核记录为准，否则取最早一条批次单件结论。
export function effectiveConclusion(specimenCode: string): EntryRow | null {
  const review = listReviews()
    .filter((row) => String(row['标本编号']) === specimenCode)
    .sort((a, b) => Number(a.id) - Number(b.id))[0]
  if (review) {
    return review
  }
  const item = listBatchItems()
    .filter((row) => String(row['标本编号']) === specimenCode)
    .sort((a, b) => Number(a.id) - Number(b.id))[0]
  return item ?? null
}

// ---- 单件提交鉴定 ----
// 幂等是修复核心：同一标本已有有效结论时，第二次提交整体拒绝，
// 不落任何数据，标本的种属判定保持第一次的结论不被覆盖。
export function submitIdentification(specimenId: number): ActionResult {
  const specimen = listRows(SPECIMEN_KEY).find((row) => Number(row.id) === specimenId)
  if (!specimen) {
    return fail(`没有找到编号为 ${specimenId} 的动物骨骼标本`)
  }
  const code = String(specimen['标本编号'])
  const existing = effectiveConclusion(code)
  if (existing) {
    return fail(
      `标本 ${code} 已存在有效鉴定结论（批次 ${existing['批次号']}，种属判定「${existing['种属判定']}」），重复提交被拒绝，种属判定维持原结论`,
    )
  }
  if (String(specimen.status) !== '鉴定中') {
    return fail(`标本 ${code} 当前状态「${specimen.status}」，请先开始鉴定再提交`)
  }
  const submittedAt = now()
  let batchNo = ''
  try {
    transact((draft) => {
      const batches = draft[BATCH_KEY] ?? []
      const batchId = nextId(batches)
      batchNo = `AB-BATCH-${String(batchId).padStart(4, '0')}`
      draft[BATCH_KEY] = [
        ...batches,
        {
          id: batchId,
          status: BATCH_PENDING,
          pending: true,
          abnormal: false,
          批次号: batchNo,
          提交时间: submittedAt,
          提交人: '值班管理员',
        },
      ]
      const items = draft[BATCH_ITEM_KEY] ?? []
      draft[BATCH_ITEM_KEY] = [
        ...items,
        {
          id: nextId(items),
          status: BATCH_PENDING,
          pending: true,
          abnormal: false,
          批次号: batchNo,
          标本编号: code,
          // 批次结论快照：提交那一刻的种属判定，之后标本上的改动不影响批次内记录
          种属判定: String(specimen['种属判定'] ?? ''),
          结论来源: '批次结论',
          提交时间: submittedAt,
        },
      ]
      draft[SPECIMEN_KEY] = (draft[SPECIMEN_KEY] ?? []).map((row) =>
        Number(row.id) === specimenId ? { ...row, status: '已鉴定', pending: true } : row,
      )
    })
  } catch (error) {
    return fail(`提交鉴定写入失败，未生成任何批次记录：${error instanceof Error ? error.message : '未知错误'}`)
  }
  return { ok: true, message: `标本 ${code} 已提交鉴定，批次 ${batchNo} 待复核` }
}

// ---- 复核写入 ----
// 一批一次：复核记录、库房待入藏事项、批次状态、标本状态同事务写入；
// 任何一步失败全部回滚，批次退回「待复核」，不允许只生成半份记录。
export function reviewBatch(batchId: number): ActionResult {
  const batch = listBatches().find((row) => Number(row.id) === batchId)
  if (!batch) {
    return fail(`没有找到编号为 ${batchId} 的鉴定批次`)
  }
  const batchNo = String(batch['批次号'])
  if (String(batch.status) === BATCH_REVIEWED) {
    return fail(`批次 ${batchNo} 已复核，不重复写入复核记录`)
  }
  const items = listBatchItems().filter((row) => String(row['批次号']) === batchNo)
  if (items.length === 0) {
    return fail(`批次 ${batchNo} 内没有单件结论，无法复核`)
  }
  // 写入前再查一次重：任一标本已有复核记录，整批拒绝，批次维持原状态
  const reviewedCodes = new Set(listReviews().map((row) => String(row['标本编号'])))
  const duplicated = items.find((item) => reviewedCodes.has(String(item['标本编号'])))
  if (duplicated) {
    return fail(
      `标本 ${duplicated['标本编号']} 已有复核记录，整批复核被拒绝，批次 ${batchNo} 维持「${BATCH_PENDING}」`,
    )
  }
  const reviewedAt = now()
  let adopted = 0
  try {
    transact((draft) => {
      const specimens = draft[SPECIMEN_KEY] ?? []
      const reviews = [...(draft[REVIEW_KEY] ?? [])]
      const intakes = [...(draft[INTAKE_KEY] ?? [])]
      let reviewId = nextId(reviews)
      let intakeId = nextId(intakes)
      for (const item of items) {
        const code = String(item['标本编号'])
        const specimen = specimens.find((row) => String(row['标本编号']) === code)
        // 批次内外结果冲突：人工单件结论（标本现行种属判定）优先于批次结论快照
        const manual = String(specimen?.['种属判定'] ?? '')
        const fromBatch = String(item['种属判定'] ?? '')
        const manualFirst = manual !== '' && manual !== fromBatch
        const conclusion = manualFirst ? manual : fromBatch
        reviews.push({
          id: reviewId,
          status: BATCH_REVIEWED,
          pending: false,
          abnormal: false,
          批次号: batchNo,
          标本编号: code,
          种属判定: conclusion,
          结论来源: manualFirst ? '人工单件' : '批次结论',
          复核时间: reviewedAt,
        })
        // 库房待入藏事项按当时复核结果快照保留，之后标本再改也不回写这里
        intakes.push({
          id: intakeId,
          status: '待入藏',
          pending: true,
          abnormal: false,
          复核编号: reviewId,
          标本编号: code,
          种属判定: conclusion,
          来源模块: '动物骨骼',
          创建时间: reviewedAt,
        })
        reviewId += 1
        intakeId += 1
        adopted += 1
      }
      draft[REVIEW_KEY] = reviews
      draft[INTAKE_KEY] = intakes
      draft[BATCH_KEY] = (draft[BATCH_KEY] ?? []).map((row) =>
        Number(row.id) === batchId
          ? { ...row, status: BATCH_REVIEWED, pending: false, 复核时间: reviewedAt }
          : row,
      )
      const codes = new Set(items.map((item) => String(item['标本编号'])))
      draft[SPECIMEN_KEY] = specimens.map((row) =>
        codes.has(String(row['标本编号'])) ? { ...row, status: BATCH_REVIEWED, pending: true } : row,
      )
    })
  } catch (error) {
    return fail(
      `复核写入失败，批次 ${batchNo} 已退回「${BATCH_PENDING}」，未生成任何记录：${error instanceof Error ? error.message : '未知错误'}`,
    )
  }
  return { ok: true, message: `批次 ${batchNo} 复核完成，写入 ${adopted} 条复核记录与 ${adopted} 条库房待入藏事项` }
}

// 列表行上的「复核鉴定」：找到该标本所在的待复核批次，整批复核。
export function reviewBatchForSpecimen(specimenId: number): ActionResult {
  const specimen = listRows(SPECIMEN_KEY).find((row) => Number(row.id) === specimenId)
  if (!specimen) {
    return fail(`没有找到编号为 ${specimenId} 的动物骨骼标本`)
  }
  const code = String(specimen['标本编号'])
  if (listReviews().some((row) => String(row['标本编号']) === code)) {
    return fail(`标本 ${code} 已有复核记录，不重复复核`)
  }
  const item = listBatchItems()
    .filter((row) => String(row['标本编号']) === code)
    .sort((a, b) => Number(a.id) - Number(b.id))[0]
  if (!item) {
    return fail(`标本 ${code} 还没有提交鉴定，请先提交再复核`)
  }
  const batch = listBatches().find((row) => String(row['批次号']) === String(item['批次号']))
  if (!batch) {
    return fail(`标本 ${code} 所在批次 ${item['批次号']} 不存在`)
  }
  return reviewBatch(Number(batch.id))
}

// ---- 库房待入藏事项 ----
export function confirmIntake(intakeId: number): ActionResult {
  const intake = listStorageIntakes().find((row) => Number(row.id) === intakeId)
  if (!intake) {
    return fail(`没有找到编号为 ${intakeId} 的待入藏事项`)
  }
  if (String(intake.status) !== '待入藏') {
    return fail(`待入藏事项 ${intakeId} 已处理，不重复操作`)
  }
  try {
    transact((draft) => {
      draft[INTAKE_KEY] = (draft[INTAKE_KEY] ?? []).map((row) =>
        Number(row.id) === intakeId ? { ...row, status: '已入藏', pending: false } : row,
      )
    })
  } catch (error) {
    return fail(`入藏确认失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
  return { ok: true, message: `标本 ${intake['标本编号']} 已入藏` }
}
