/**
 * 动物骨骼鉴定域服务：批次、单件提交、复核写入、库房待入藏与架位台账的唯一写入口。
 *
 * 取数口径（列表页与库房页共用，杜绝「同一个共享鉴定批次口径」被两边各 join 一次）：
 *   批次内结果取每个批次自己的 items；批次外取人工单件结论；
 *   统一由 effectiveResult() 按标本选出唯一有效结论 —— 人工单件结论恒优先于批次结论。
 *
 * 写入纪律：
 *   1. 重复提交：一件标本已有有效结论后，再次提交（无论换不换批次）一律拒绝，
 *      不新增复核记录、不改写种属判定；只有第一次有效结论被承认。
 *   2. 冲突仲裁：批次内外结果冲突（种属不一致）时，系统采用人工单件结论。
 *      人工单件提交会把批次内旧结论标记 superseded，并把该标本的复核口径切到人工件。
 *      已经生成的跨业务库房待入藏事项按当时复核结果保留，不回改、不重复。
 *   3. 原子性：批次提交、复核、上架都走 commitTables 事务；任一写入环节抛错，
 *      所有表整体恢复到写入前快照，批次退回原状态，绝不只生成半份记录。
 */
import { listRows, listTable, saveTable } from '@/data/local-store'
import {
  SEED_BONE_BATCHES,
  SEED_BONE_MANUAL,
  SEED_BONE_REVIEWS,
  SEED_STORAGE_INTAKES,
  SEED_STORAGE_LEDGER,
} from '@/data/bone-seed'
import type { EntryRow } from '@/data/types'
import type {
  BatchWriteReceipt,
  BoneBatch,
  BoneBatchItem,
  BoneManualResult,
  BoneReview,
  EffectiveBoneResult,
  StorageIntake,
  StorageLedgerEntry,
} from '@/data/bone-types'

const SPECIMEN_KEY = 'animal_bone'
const TABLE_BATCH = 'bone_batch'
const TABLE_MANUAL = 'bone_manual'
const TABLE_REVIEW = 'bone_review'
const TABLE_INTAKE = 'storage_intake'
const TABLE_LEDGER = 'storage_ledger'

function nowText(): string {
  return new Date().toISOString()
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// ---------------------------------------------------------------------------
// 读侧：批次 / 人工单件 / 复核 / 库房
// ---------------------------------------------------------------------------

export function listBatches(): BoneBatch[] {
  return listTable<BoneBatch>(TABLE_BATCH)
}

export function listManualResults(): BoneManualResult[] {
  return listTable<BoneManualResult>(TABLE_MANUAL)
}

export function listReviews(): BoneReview[] {
  return listTable<BoneReview>(TABLE_REVIEW)
}

export function listIntakes(): StorageIntake[] {
  return listTable<StorageIntake>(TABLE_INTAKE)
}

export function listLedger(): StorageLedgerEntry[] {
  return listTable<StorageLedgerEntry>(TABLE_LEDGER)
}

/** 该标本最新的批次内有效结论：批次必须已提交，且该件结论未被人工件压过。 */
function findBatchResult(
  batches: BoneBatch[],
  specimenId: number,
): { batch: BoneBatch; item: BoneBatchItem } | null {
  for (const batch of [...batches]
    .filter((item) => item.status !== '鉴定中' && item.提交时间)
    .sort((a, b) => (a.提交时间! < b.提交时间! ? 1 : -1))) {
    const item = batch.items.find((row) => row.specimenId === specimenId && !row.superseded)
    if (item) {
      return { batch, item }
    }
  }
  return null
}

/**
 * 统一有效结论选择器：列表页、复核页、库房页只允许通过它取一件标本的结论。
 * 人工单件结论恒优先；没有人工件时才回落到批次内结论。
 */
export function effectiveResult(
  specimenId: number,
  manualRows: BoneManualResult[] = listManualResults(),
  batches: BoneBatch[] = listBatches(),
): EffectiveBoneResult | null {
  const manual = [...manualRows]
    .filter((row) => row.specimenId === specimenId)
    .sort((a, b) => (a.提交时间 < b.提交时间 ? 1 : -1))[0]
  if (manual) {
    return {
      specimenId: manual.specimenId,
      标本编号: manual.标本编号,
      种属判定: manual.种属判定,
      骨骼部位: manual.骨骼部位,
      数量统计: manual.数量统计,
      最小个体数: manual.最小个体数,
      鉴定人: manual.鉴定人,
      source: '人工单件',
      batchId: null,
      exists: true,
    }
  }
  const hit = findBatchResult(batches, specimenId)
  if (hit) {
    const { batch, item } = hit
    return {
      specimenId: item.specimenId,
      标本编号: item.标本编号,
      种属判定: item.种属判定,
      骨骼部位: item.骨骼部位,
      数量统计: item.数量统计,
      最小个体数: item.最小个体数,
      鉴定人: item.鉴定人,
      source: '批次',
      batchId: batch.id,
      exists: true,
    }
  }
  return null
}

/** 全部标本（去重后一件一行）的有效结论视图，列表页和库房页共用这一个口径。 */
export interface SpecimenView {
  row: EntryRow
  result: EffectiveBoneResult | null
  review: BoneReview | null
  intake: StorageIntake | null
  ledger: StorageLedgerEntry | null
}

export function specimenViews(): SpecimenView[] {
  const specimens = listRows(SPECIMEN_KEY)
  const manualRows = listManualResults()
  const batches = listBatches()
  const reviews = listReviews()
  const intakes = listIntakes()
  const ledgers = listLedger()
  return specimens.map((row) => {
    const id = Number(row.id)
    return {
      row,
      result: effectiveResult(id, manualRows, batches),
      review: reviews.find((item) => item.specimenId === id && item.status === '待复核')
        ?? reviews.filter((item) => item.specimenId === id).slice(-1)[0]
        ?? null,
      intake: intakes.find((item) => item.specimenId === id) ?? null,
      ledger: ledgers.find((item) => item.specimenId === id) ?? null,
    }
  })
}

// ---------------------------------------------------------------------------
// 原子提交：多表要么全部生效，要么整体回退到写入前快照
// ---------------------------------------------------------------------------

type WritableTables = {
  [TABLE_BATCH]?: BoneBatch[]
  [TABLE_MANUAL]?: BoneManualResult[]
  [TABLE_REVIEW]?: BoneReview[]
  [TABLE_INTAKE]?: StorageIntake[]
  [TABLE_LEDGER]?: StorageLedgerEntry[]
}

function snapshotAll(): WritableTables {
  return {
    [TABLE_BATCH]: listBatches().map((row) => ({ ...row, items: row.items.map((item) => ({ ...item })) })),
    [TABLE_MANUAL]: listManualResults().map((row) => ({ ...row })),
    [TABLE_REVIEW]: listReviews().map((row) => ({ ...row })),
    [TABLE_INTAKE]: listIntakes().map((row) => ({ ...row })),
    [TABLE_LEDGER]: listLedger().map((row) => ({ ...row })),
  }
}

function restoreTables(snapshot: WritableTables): void {
  saveTable(TABLE_BATCH, snapshot[TABLE_BATCH] ?? [])
  saveTable(TABLE_MANUAL, snapshot[TABLE_MANUAL] ?? [])
  saveTable(TABLE_REVIEW, snapshot[TABLE_REVIEW] ?? [])
  saveTable(TABLE_INTAKE, snapshot[TABLE_INTAKE] ?? [])
  saveTable(TABLE_LEDGER, snapshot[TABLE_LEDGER] ?? [])
}

/**
 * 事务写：mutator 内构造下一份各表数据；返回值作为业务回执。
 * mutator 任一步抛错（含并发版本号不匹配）时，全部表恢复快照，调用方看到的是「退回原状态」。
 */
function commitTables<T>(mutator: (draft: Required<WritableTables>) => T): T {
  const snapshot = snapshotAll()
  const draft: Required<WritableTables> = {
    [TABLE_BATCH]: snapshot[TABLE_BATCH]!,
    [TABLE_MANUAL]: snapshot[TABLE_MANUAL]!,
    [TABLE_REVIEW]: snapshot[TABLE_REVIEW]!,
    [TABLE_INTAKE]: snapshot[TABLE_INTAKE]!,
    [TABLE_LEDGER]: snapshot[TABLE_LEDGER]!,
  }
  try {
    const receipt = mutator(draft)
    saveTable(TABLE_BATCH, draft[TABLE_BATCH])
    saveTable(TABLE_MANUAL, draft[TABLE_MANUAL])
    saveTable(TABLE_REVIEW, draft[TABLE_REVIEW])
    saveTable(TABLE_INTAKE, draft[TABLE_INTAKE])
    saveTable(TABLE_LEDGER, draft[TABLE_LEDGER])
    return receipt
  } catch (error) {
    restoreTables(snapshot)
    throw error
  }
}

class BatchWriteError extends Error {
  constructor(
    message: string,
    readonly batchId: number | null = null,
    readonly rollbackStatus: BoneBatch['status'] | null = null,
  ) {
    super(message)
    this.name = 'BatchWriteError'
  }
}

function requireSpecimen(specimens: EntryRow[], specimenId: number): EntryRow {
  const row = specimens.find((item) => Number(item.id) === specimenId)
  if (!row) {
    throw new BatchWriteError(`标本 ${specimenId} 不存在，无法写入鉴定结论`)
  }
  return row
}

function toInt(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

// ---------------------------------------------------------------------------
// 批次创建 / 批次提交
// ---------------------------------------------------------------------------

export function createBatch(submitter: string): BoneBatch {
  return commitTables((draft) => {
    const batch: BoneBatch = {
      id: nextId(draft[TABLE_BATCH]),
      批次编号: `BATCH-${String(nextId(draft[TABLE_BATCH])).padStart(4, '0')}`,
      status: '鉴定中',
      提交人: submitter,
      创建时间: nowText(),
      提交时间: null,
      items: [],
    }
    draft[TABLE_BATCH] = [...draft[TABLE_BATCH], batch]
    return batch
  })
}

export interface BatchSubmitItem {
  specimenId: number
  种属判定: string
  骨骼部位?: string
  数量统计?: number
  最小个体数?: number
}

/**
 * 批次提交：逐件写入批次内单件结论，并为每件生成「待复核」记录。
 * 任一环节失败（标本不存在、该标本已有有效结论、并发写入）整批回退，
 * 批次保持「鉴定中」，不产生任何单件结论、复核记录或库房事项。
 */
export function submitBatch(
  batchId: number,
  payloadItems: BatchSubmitItem[],
  submitter: string,
): BatchWriteReceipt {
  const snapshot = snapshotAll()
  try {
    return commitTables((draft) => {
      const batches = draft[TABLE_BATCH]
      const index = batches.findIndex((row) => row.id === batchId)
      if (index < 0) {
        throw new BatchWriteError(`批次 ${batchId} 不存在`, batchId)
      }
      const batch = batches[index]
      if (batch.status !== '鉴定中') {
        // 并发重复提交：后一次必须被拒绝，批次保持已有状态。
        throw new BatchWriteError(
          `批次「${batch.批次编号}」当前为「${batch.status}」，重复提交已拒绝`,
          batchId,
          batch.status,
        )
      }
      if (payloadItems.length === 0) {
        throw new BatchWriteError('批次内没有单件结论，不能空批提交', batchId, batch.status)
      }

      const specimens = listRows(SPECIMEN_KEY)
      const seen = new Set<number>()
      const items: BoneBatchItem[] = []
      const reviews: BoneReview[] = []

      for (const payload of payloadItems) {
        if (seen.has(payload.specimenId)) {
          // 同一批次里同一件标本连续提交两次：只认第一次，第二次拒绝，整批不生效。
          throw new BatchWriteError(
            `标本 ${payload.specimenId} 在本批次内重复提交，第二次提交已拒绝`,
            batchId,
            '鉴定中',
          )
        }
        seen.add(payload.specimenId)

        const row = requireSpecimen(specimens, payload.specimenId)
        // 跨批次重复：该标本已存在任何有效结论（人工件或别的批次件），拒绝且不得覆盖种属判定。
        const existing = effectiveResult(
          payload.specimenId,
          draft[TABLE_MANUAL],
          draft[TABLE_BATCH],
        )
        if (existing) {
          throw new BatchWriteError(
            `标本「${String(row.标本编号)}」已存在第一次有效结论（${existing.source}口径：${existing.种属判定}），重复提交已拒绝，种属判定不覆盖`,
            batchId,
            '鉴定中',
          )
        }
        if (!payload.种属判定?.trim()) {
          throw new BatchWriteError(`标本「${String(row.标本编号)}」缺少种属判定`, batchId, '鉴定中')
        }

        const item: BoneBatchItem = {
          specimenId: payload.specimenId,
          标本编号: String(row.标本编号),
          种属判定: payload.种属判定.trim(),
          骨骼部位: payload.骨骼部位?.trim() || String(row.骨骼部位 ?? ''),
          数量统计: payload.数量统计 ?? toInt(row.数量统计),
          最小个体数: payload.最小个体数 ?? toInt(row.最小个体数),
          鉴定人: submitter,
          superseded: false,
        }
        items.push(item)
        reviews.push({
          id: nextId([...draft[TABLE_REVIEW], ...reviews]),
          specimenId: payload.specimenId,
          标本编号: item.标本编号,
          结论来源: '批次',
          batchId,
          种属判定: item.种属判定,
          提交时间: nowText(),
          status: '待复核',
          复核人: null,
          复核时间: null,
          复核意见: '',
        })
      }

      // 全部单件校验通过后才一次性落盘：不允许只生成半份记录。
      draft[TABLE_BATCH] = batches.map((row, rowIndex) =>
        rowIndex === index
          ? { ...row, status: '待复核', 提交时间: nowText(), items: [...row.items, ...items] }
          : row,
      )
      draft[TABLE_REVIEW] = [...draft[TABLE_REVIEW], ...reviews]
      return {
        ok: true,
        message: `批次「${batch.批次编号}」已提交 ${items.length} 件，等待复核`,
        rollbackStatus: null,
        batchId,
      }
    })
  } catch (error) {
    // commitTables 已把所有表恢复到提交前快照；这里再显式保证批次退回原状态。
    restoreTables(snapshot)
    if (error instanceof BatchWriteError) {
      return {
        ok: false,
        message: error.message,
        rollbackStatus: error.rollbackStatus,
        batchId: error.batchId,
      }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : '批次提交失败，已退回「鉴定中」',
      rollbackStatus: '鉴定中',
      batchId,
    }
  }
}

// ---------------------------------------------------------------------------
// 批次外人工单件提交：冲突时人工单件优先
// ---------------------------------------------------------------------------

export interface ManualSubmitInput {
  specimenId: number
  种属判定: string
  骨骼部位?: string
  数量统计?: number
  最小个体数?: number
  鉴定人: string
}

/**
 * 人工单件提交（批次外口径）。
 * - 该标本已有同口径同种属的有效结论：视为重复提交，拒绝且不覆盖种属判定；
 * - 与批次内结论冲突：采用人工单件结论，批次内旧结论标记 superseded，
 *   该标本的待复核记录改挂人工件；已生成的库房待入藏事项按当时复核结果保留。
 */
export function submitManualResult(input: ManualSubmitInput): BatchWriteReceipt {
  const snapshot = snapshotAll()
  try {
    return commitTables((draft) => {
      const specimens = listRows(SPECIMEN_KEY)
      const row = requireSpecimen(specimens, input.specimenId)
      if (!input.种属判定?.trim()) {
        throw new BatchWriteError('人工单件结论缺少种属判定')
      }
      const species = input.种属判定.trim()

      const existingManual = draft[TABLE_MANUAL]
        .filter((item) => item.specimenId === input.specimenId)
        .sort((a, b) => (a.提交时间 < b.提交时间 ? 1 : -1))[0]
      if (existingManual) {
        // 第一次有效结论之后的再次人工提交：必须被拒绝，种属判定不覆盖。
        throw new BatchWriteError(
          `标本「${existingManual.标本编号}」已存在第一次有效人工结论（${existingManual.种属判定}），重复提交已拒绝`,
        )
      }

      const batchHit = findBatchResult(draft[TABLE_BATCH], input.specimenId)
      const manual: BoneManualResult = {
        id: nextId(draft[TABLE_MANUAL]),
        specimenId: input.specimenId,
        标本编号: String(row.标本编号),
        种属判定: species,
        骨骼部位: input.骨骼部位?.trim() || String(row.骨骼部位 ?? ''),
        数量统计: input.数量统计 ?? toInt(row.数量统计),
        最小个体数: input.最小个体数 ?? toInt(row.最小个体数),
        鉴定人: input.鉴定人,
        提交时间: nowText(),
      }
      draft[TABLE_MANUAL] = [...draft[TABLE_MANUAL], manual]

      if (batchHit && batchHit.item.种属判定 !== species) {
        // 批次内外冲突：系统采用人工单件结论 —— 压过批次件。
        draft[TABLE_BATCH] = draft[TABLE_BATCH].map((batch) =>
          batch.id === batchHit.batch.id
            ? {
                ...batch,
                items: batch.items.map((item) =>
                  item.specimenId === input.specimenId ? { ...item, superseded: true } : item,
                ),
              }
            : batch,
        )
        // 既有复核记录（无论当时结论是什么）改挂人工件并回到「待复核」，
        // 保证人工改判重新经过复核环节，但一件标本始终只有一条复核记录。
        const former = draft[TABLE_REVIEW]
          .filter((review) => review.specimenId === input.specimenId)
          .slice(-1)[0]
        if (former) {
          draft[TABLE_REVIEW] = draft[TABLE_REVIEW].map((review) =>
            review.id === former.id
              ? {
                  ...review,
                  结论来源: '人工单件',
                  batchId: null,
                  种属判定: species,
                  提交时间: nowText(),
                  status: '待复核',
                  复核人: null,
                  复核时间: null,
                  复核意见: '',
                }
              : review,
          )
        } else {
          draft[TABLE_REVIEW] = [
            ...draft[TABLE_REVIEW],
            {
              id: nextId(draft[TABLE_REVIEW]),
              specimenId: input.specimenId,
              标本编号: manual.标本编号,
              结论来源: '人工单件' as const,
              batchId: null,
              种属判定: species,
              提交时间: nowText(),
              status: '待复核' as const,
              复核人: null,
              复核时间: null,
              复核意见: '',
            },
          ]
        }
        return {
          ok: true,
          message: `标本「${manual.标本编号}」批次内结论与人工单件冲突，系统采用人工单件结论（${species}），批次内原结论已压过；已生成的库房事项按原复核结果保留`,
          rollbackStatus: null,
          batchId: batchHit.batch.id,
        }
      }

      // 无批次结论（或种属一致）：作为首次有效结论，建立一条待复核。
      const alreadyPending = draft[TABLE_REVIEW].some(
        (review) => review.specimenId === input.specimenId && review.status === '待复核',
      )
      if (!alreadyPending) {
        draft[TABLE_REVIEW] = [
          ...draft[TABLE_REVIEW],
          {
            id: nextId(draft[TABLE_REVIEW]),
            specimenId: input.specimenId,
            标本编号: manual.标本编号,
            结论来源: '人工单件' as const,
            batchId: null,
            种属判定: species,
            提交时间: nowText(),
            status: '待复核' as const,
            复核人: null,
            复核时间: null,
            复核意见: '',
          },
        ]
      }
      return {
        ok: true,
        message: `标本「${manual.标本编号}」人工单件结论（${species}）已提交，等待复核`,
        rollbackStatus: null,
        batchId: batchHit?.batch.id ?? null,
      }
    })
  } catch (error) {
    restoreTables(snapshot)
    if (error instanceof BatchWriteError) {
      return { ok: false, message: error.message, rollbackStatus: null, batchId: null }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : '人工单件提交失败，数据已回退',
      rollbackStatus: null,
      batchId: null,
    }
  }
}

// ---------------------------------------------------------------------------
// 复核写入：通过则幂等生成库房待入藏事项；整批评审在全件完成后收口批次状态
// ---------------------------------------------------------------------------

export interface ReviewDecision {
  reviewId: number
  pass: boolean
  reviewer: string
  opinion?: string
}

/** 单条复核：幂等 —— 已决的复核再次提交不产生第二条待入藏事项。 */
export function decideReview(decision: ReviewDecision): BatchWriteReceipt {
  const snapshot = snapshotAll()
  try {
    return commitTables((draft) => {
      const reviewIndex = draft[TABLE_REVIEW].findIndex((row) => row.id === decision.reviewId)
      if (reviewIndex < 0) {
        throw new BatchWriteError(`复核记录 ${decision.reviewId} 不存在`)
      }
      const review = draft[TABLE_REVIEW][reviewIndex]
      if (review.status !== '待复核') {
        // 同一条复核被连续提交两次：只认第一次结论，后一次拒绝，不重复写库房。
        return {
          ok: false,
          message: `标本「${review.标本编号}」已复核（${review.status}），重复复核已拒绝`,
          rollbackStatus: null,
          batchId: review.batchId,
        }
      }

      const decided: BoneReview = {
        ...review,
        status: decision.pass ? '复核通过' : '复核拒绝',
        复核人: decision.reviewer,
        复核时间: nowText(),
        复核意见: decision.opinion?.trim() ?? (decision.pass ? '同意鉴定结论' : '退回重鉴'),
      }
      draft[TABLE_REVIEW] = draft[TABLE_REVIEW].map((row, index) =>
        index === reviewIndex ? decided : row,
      )

      if (decision.pass) {
        const existsIntake = draft[TABLE_INTAKE].some(
          (item) => item.specimenId === review.specimenId,
        )
        if (!existsIntake) {
          // 跨业务面库房待入藏事项：按「当时复核结果」保留快照，之后人工改判不回改、不另建。
          const result = effectiveResult(
            review.specimenId,
            draft[TABLE_MANUAL],
            draft[TABLE_BATCH],
          )
          draft[TABLE_INTAKE] = [
            ...draft[TABLE_INTAKE],
            {
              id: nextId(draft[TABLE_INTAKE]),
              specimenId: review.specimenId,
              标本编号: review.标本编号,
              种属判定: review.种属判定,
              骨骼部位: result?.骨骼部位 ?? '',
              数量统计: result?.数量统计 ?? 0,
              来源批次: review.结论来源 === '批次' ? review.batchId : null,
              生成时间: nowText(),
              status: '待入藏' as const,
            },
          ]
        }
      }

      // 若该批次下已无待复核件，批次收口为「复核完成」；存在拒绝件时批次同样收口，
      // 因为每件结论都已有第一次有效复核结论（拒绝件不会进入库房）。
      if (review.batchId !== null) {
        const pendingOfBatch = draft[TABLE_REVIEW].some(
          (row) => row.batchId === review.batchId && row.status === '待复核',
        )
        if (!pendingOfBatch) {
          draft[TABLE_BATCH] = draft[TABLE_BATCH].map((batch) =>
            batch.id === review.batchId && batch.status === '待复核'
              ? { ...batch, status: '复核完成' }
              : batch,
          )
        }
      }

      return {
        ok: true,
        message: decision.pass
          ? `标本「${review.标本编号}」复核通过，已按复核时结论生成待入藏事项`
          : `标本「${review.标本编号}」复核拒绝，结论退回，不生成待入藏事项`,
        rollbackStatus: null,
        batchId: review.batchId,
      }
    })
  } catch (error) {
    restoreTables(snapshot)
    return {
      ok: false,
      message: error instanceof Error ? error.message : '复核写入失败，数据已回退',
      rollbackStatus: null,
      batchId: null,
    }
  }
}

// ---------------------------------------------------------------------------
// 架位台账生成：待入藏事项上架；多件一起上架时任一失败全部回退，不生成半份台账
// ---------------------------------------------------------------------------

export interface ShelfPlacement {
  intakeId: number
  架位编号: string
  操作人: string
}

export function placeIntakes(placements: ShelfPlacement[]): BatchWriteReceipt {
  const snapshot = snapshotAll()
  try {
    return commitTables((draft) => {
      if (placements.length === 0) {
        throw new BatchWriteError('没有需要上架的待入藏事项')
      }
      const seen = new Set<number>()
      const ledgerEntries: StorageLedgerEntry[] = []
      const intakeUpdates = new Map<number, StorageIntake>()

      for (const placement of placements) {
        if (seen.has(placement.intakeId)) {
          throw new BatchWriteError(`待入藏事项 ${placement.intakeId} 重复上架，第二次已拒绝`)
        }
        seen.add(placement.intakeId)
        if (!placement.架位编号?.trim()) {
          throw new BatchWriteError(`待入藏事项 ${placement.intakeId} 缺少架位编号`)
        }
        const intake = draft[TABLE_INTAKE].find((row) => row.id === placement.intakeId)
        if (!intake) {
          throw new BatchWriteError(`待入藏事项 ${placement.intakeId} 不存在`)
        }
        if (intake.status !== '待入藏') {
          // 台账幂等：同一件标本已经上架，再次写入拒绝，不生成第二条台账。
          throw new BatchWriteError(`标本「${intake.标本编号}」已上架，重复生成台账已拒绝`)
        }
        ledgerEntries.push({
          id: nextId([...draft[TABLE_LEDGER], ...ledgerEntries]),
          intakeId: intake.id,
          specimenId: intake.specimenId,
          标本编号: intake.标本编号,
          种属判定: intake.种属判定,
          架位编号: placement.架位编号.trim(),
          上架时间: nowText(),
          操作人: placement.操作人,
        })
        intakeUpdates.set(intake.id, { ...intake, status: '已上架' })
      }

      // 逐件预校验全部通过后才一次性提交台账与事项状态。
      draft[TABLE_LEDGER] = [...draft[TABLE_LEDGER], ...ledgerEntries]
      draft[TABLE_INTAKE] = draft[TABLE_INTAKE].map((row) => intakeUpdates.get(row.id) ?? row)
      return {
        ok: true,
        message: `${ledgerEntries.length} 件标本已上架，架位台账完整生成`,
        rollbackStatus: null,
        batchId: null,
      }
    })
  } catch (error) {
    restoreTables(snapshot)
    return {
      ok: false,
      message: error instanceof Error ? error.message : '上架写入失败，台账与事项均已回退',
      rollbackStatus: null,
      batchId: null,
    }
  }
}

/** 鉴定域数据重置（供页面「恢复示例」使用），含批次/复核/库房派生的全部表。 */
export function resetBoneDomain(): void {
  saveTable(TABLE_BATCH, structuredCloneSafe(SEED_BONE_BATCHES))
  saveTable(TABLE_MANUAL, structuredCloneSafe(SEED_BONE_MANUAL))
  saveTable(TABLE_REVIEW, structuredCloneSafe(SEED_BONE_REVIEWS))
  saveTable(TABLE_INTAKE, structuredCloneSafe(SEED_STORAGE_INTAKES))
  saveTable(TABLE_LEDGER, structuredCloneSafe(SEED_STORAGE_LEDGER))
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
