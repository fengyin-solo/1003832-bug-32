/**
 * 动物骨骼鉴定域的类型定义。
 *
 * 数据分三类口径，互不混表：
 * - 鉴定批次（bone_batch）：一次批量鉴定提交，含批次状态与批次内单件结果；
 * - 人工单件结论（bone_manual）：批次之外由鉴定人对单件标本下的人工结论；
 * - 复核记录（bone_review）：对「标本当前有效结论」的复核，一件标本只允许存在一条有效复核；
 *
 * 复核通过后向库房侧派生（跨业务面，只按当时复核结果生成一次，幂等）：
 * - 待入藏事项（storage_intake）：一件标本至多一条；
 * - 架位台账（storage_ledger）：待入藏事项上架后生成，一件标本至多一条。
 */

/** 鉴定批次状态。提交失败或并发写入失败时必须退回上一状态，不允许停在中间态。 */
export type BoneBatchStatus = '鉴定中' | '待复核' | '复核完成'

/** 单件鉴定结论的来源口径。 */
export type BoneResultSource = '批次' | '人工单件'

/** 批次内单件鉴定结果：批次提交时逐件写入。 */
export interface BoneBatchItem {
  /** 标本行 id（animal_bone 列表的 id） */
  specimenId: number
  标本编号: string
  种属判定: string
  骨骼部位: string
  数量统计: number
  最小个体数: number
  鉴定人: string
  /** 该件结论是否已被批次外的人工单件结论压过；压过后批次内结论不再作为有效口径。 */
  superseded: boolean
}

export interface BoneBatch {
  id: number
  批次编号: string
  status: BoneBatchStatus
  提交人: string
  创建时间: string
  提交时间: string | null
  items: BoneBatchItem[]
}

/** 批次外的人工单件鉴定结论：与批次结论冲突时，系统一律采用它（人工单件优先）。 */
export interface BoneManualResult {
  id: number
  specimenId: number
  标本编号: string
  种属判定: string
  骨骼部位: string
  数量统计: number
  最小个体数: number
  鉴定人: string
  提交时间: string
}

/** 复核环节。一件标本的有效结论只对应一条复核记录；重复提交/重复复核都在原记录上幂等处理。 */
export interface BoneReview {
  id: number
  specimenId: number
  标本编号: string
  /** 被复核结论的口径：批次 / 人工单件 */
  结论来源: BoneResultSource
  /** 批次口径时记录所属批次，人工压过批次时同步改写为「人工单件」 */
  batchId: number | null
  种属判定: string
  提交时间: string
  status: '待复核' | '复核通过' | '复核拒绝'
  复核人: string | null
  复核时间: string | null
  复核意见: string
}

/** 库房待入藏事项：复核通过时按当时复核结果生成；一件标本至多一条，重复复核不重复创建。 */
export interface StorageIntake {
  id: number
  specimenId: number
  标本编号: string
  /** 生成该事项时复核认定的种属（历史口径，后续人工改判不回改已生成的跨业务事项） */
  种属判定: string
  骨骼部位: string
  数量统计: number
  来源批次: number | null
  生成时间: string
  status: '待入藏' | '已上架'
}

/** 架位台账：待入藏事项上架后写入；一件标本至多一条。 */
export interface StorageLedgerEntry {
  id: number
  intakeId: number
  specimenId: number
  标本编号: string
  种属判定: string
  架位编号: string
  上架时间: string
  操作人: string
}

/** 一件标本在统一口径下的有效结论：列表页与库房页都只认这一个选择器的结果。 */
export interface EffectiveBoneResult {
  specimenId: number
  标本编号: string
  种属判定: string
  骨骼部位: string
  数量统计: number
  最小个体数: number
  鉴定人: string
  source: BoneResultSource
  batchId: number | null
  /** 该标本是否已经存在有效结论（重复提交时第二次必须被拒绝） */
  exists: boolean
}

/** 批次写入的并发/失败回执。 */
export interface BatchWriteReceipt {
  ok: boolean
  message: string
  /** 失败时批次退回的状态（即写入前原状态），便于核对没有半成品 */
  rollbackStatus: BoneBatchStatus | null
  batchId: number | null
}
