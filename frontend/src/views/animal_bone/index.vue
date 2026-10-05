<template>
  <section class="page" data-module="animal_bone">
    <header class="page-head">
      <div>
        <h2>动物骨骼管理</h2>
        <p class="page-desc">鉴定批次与批次外人工单件结论统一取数：一件标本只呈现一条有效结论，重复提交只认第一次，冲突时人工单件优先。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="resetDomain">恢复鉴定域示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">标本总数</span>
        <strong class="stat-value">{{ views.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已有有效结论</span>
        <strong class="stat-value">{{ views.filter((item) => item.result).length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待复核</span>
        <strong class="stat-value">{{ pendingReviews.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">库房待入藏</span>
        <strong class="stat-value">{{ pendingIntakeCount }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>标本编号</span>
        <input v-model="filters.code" placeholder="按标本编号检索" />
      </label>
      <label class="filter-item">
        <span>种属判定</span>
        <input v-model="filters.species" placeholder="按种属判定检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <h3 class="section-title">标本鉴定清单（批次 / 人工单件统一口径）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>标本编号</th>
          <th>出土单位</th>
          <th>有效种属判定</th>
          <th>结论口径</th>
          <th>骨骼部位</th>
          <th>数量</th>
          <th>最小个体数</th>
          <th>复核状态</th>
          <th>库房去向</th>
          <th>单件操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in filteredViews" :key="String(item.row.id)">
          <td>{{ item.row.标本编号 }}</td>
          <td>{{ item.row.出土单位 }}</td>
          <td>{{ item.result ? item.result.种属判定 : '—' }}</td>
          <td>
            <span v-if="item.result" :class="['source-tag', item.result.source === '人工单件' ? 'manual' : 'batch']">
              {{ item.result.source }}<template v-if="item.result.batchId">（{{ batchLabel(item.result.batchId) }}）</template>
            </span>
            <template v-else>—</template>
          </td>
          <td>{{ item.result ? item.result.骨骼部位 : '—' }}</td>
          <td>{{ item.result ? item.result.数量统计 : '—' }}</td>
          <td>{{ item.result ? item.result.最小个体数 : '—' }}</td>
          <td>{{ item.review ? item.review.status : '未提交' }}</td>
          <td>
            <template v-if="item.ledger">已上架 {{ item.ledger.架位编号 }}</template>
            <template v-else-if="item.intake">待入藏</template>
            <template v-else>—</template>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openManual(item)">人工单件结论</button>
          </td>
        </tr>
        <tr v-if="!filteredViews.length">
          <td colspan="10" class="empty-state">暂无符合条件的动物骨骼标本</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">鉴定批次</h3>
    <div class="batch-bar">
      <button class="btn primary" type="button" @click="createNewBatch">新建鉴定批次</button>
      <span class="hint">批次提交逐件校验：任一标本已有第一次有效结论则整批拒绝并退回「鉴定中」，不产生半份记录。</span>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>批次编号</th>
          <th>状态</th>
          <th>提交人</th>
          <th>件数</th>
          <th>提交时间</th>
          <th>批次内单件结论</th>
          <th>批次操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in batches" :key="batch.id">
          <td>{{ batch.批次编号 }}</td>
          <td>{{ batch.status }}</td>
          <td>{{ batch.提交人 }}</td>
          <td>{{ batch.items.length }}</td>
          <td>{{ formatTime(batch.提交时间) }}</td>
          <td>
            <span v-for="entry in batch.items" :key="entry.specimenId" class="item-chip" :class="{ superseded: entry.superseded }">
              {{ entry.标本编号 }}：{{ entry.种属判定 }}<template v-if="entry.superseded">（已被人工件压过）</template>
            </span>
          </td>
          <td class="row-actions">
            <button v-if="batch.status === '鉴定中'" class="link" type="button" @click="openBatchSubmit(batch)">提交批次</button>
            <span v-else class="hint">已提交，逐件在下方复核</span>
          </td>
        </tr>
        <tr v-if="!batches.length">
          <td colspan="7" class="empty-state">暂无鉴定批次</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">复核队列（一件标本一条有效复核）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>标本编号</th>
          <th>结论口径</th>
          <th>种属判定</th>
          <th>提交时间</th>
          <th>复核状态</th>
          <th>复核意见</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="review in reviews" :key="review.id">
          <td>{{ review.标本编号 }}</td>
          <td>{{ review.结论来源 }}<template v-if="review.batchId">（{{ batchLabel(review.batchId) }}）</template></td>
          <td>{{ review.种属判定 }}</td>
          <td>{{ formatTime(review.提交时间) }}</td>
          <td>{{ review.status }}</td>
          <td>{{ review.复核意见 || '—' }}</td>
          <td class="row-actions">
            <template v-if="review.status === '待复核'">
              <button class="link" type="button" @click="decide(review, true)">复核通过</button>
              <button class="link danger" type="button" @click="decide(review, false)">复核拒绝</button>
            </template>
            <span v-else class="hint">{{ review.复核人 }} · {{ formatTime(review.复核时间) }}</span>
          </td>
        </tr>
        <tr v-if="!reviews.length">
          <td colspan="7" class="empty-state">暂无复核记录</td>
        </tr>
      </tbody>
    </table>

    <div v-if="manualDialog.open" class="modal-mask" @click.self="manualDialog.open = false">
      <form class="modal-card" @submit.prevent="submitManual">
        <h4>人工单件结论 · {{ manualDialog.code }}</h4>
        <p class="hint">批次内外结果冲突时系统采用人工单件结论；重复提交（种属与已有结论一致或已存在人工件）将被拒绝。</p>
        <label><span>种属判定</span><input v-model="manualDialog.species" required placeholder="如：水鹿" /></label>
        <label><span>骨骼部位</span><input v-model="manualDialog.part" placeholder="如：角枝" /></label>
        <label><span>数量统计</span><input v-model.number="manualDialog.count" type="number" min="0" /></label>
        <label><span>最小个体数</span><input v-model.number="manualDialog.mni" type="number" min="0" /></label>
        <label><span>鉴定人</span><input v-model="manualDialog.expert" required /></label>
        <div class="modal-actions">
          <button class="btn primary" type="submit">提交人工结论</button>
          <button class="btn ghost" type="button" @click="manualDialog.open = false">取消</button>
        </div>
      </form>
    </div>

    <div v-if="batchDialog.open" class="modal-mask" @click.self="batchDialog.open = false">
      <form class="modal-card" @submit.prevent="submitBatchForm">
        <h4>批次提交 · {{ batchDialog.code }}</h4>
        <p class="hint">勾选本批次鉴定的标本并填写种属；已存在有效结论的标本不能再次进入批次。</p>
        <table class="data-table inner">
          <thead>
            <tr><th>选</th><th>标本编号</th><th>出土单位</th><th>已有结论</th><th>种属判定</th></tr>
          </thead>
          <tbody>
            <tr v-for="candidate in batchDialog.candidates" :key="candidate.specimenId">
              <td><input v-model="candidate.checked" type="checkbox" :disabled="candidate.alreadyHasResult" /></td>
              <td>{{ candidate.code }}</td>
              <td>{{ candidate.unit }}</td>
              <td>{{ candidate.alreadyHasResult ? `${candidate.existingSource}：${candidate.existingSpecies}` : '无' }}</td>
              <td><input v-model="candidate.species" :disabled="!candidate.checked || candidate.alreadyHasResult" placeholder="填写种属" /></td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn primary" type="submit">整批提交</button>
          <button class="btn ghost" type="button" @click="batchDialog.open = false">取消</button>
        </div>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ filteredViews.length }} 件标本 · {{ batches.length }} 个批次 · {{ reviews.length }} 条复核记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createBatch,
  decideReview,
  listBatches,
  listReviews,
  specimenViews,
  submitBatch,
  submitManualResult,
  resetBoneDomain,
} from '@/api/bone-service'
import type { BoneBatch, BoneReview } from '@/data/bone-types'
import type { SpecimenView } from '@/api/bone-service'

const views = ref<SpecimenView[]>([])
const batches = ref<BoneBatch[]>([])
const reviews = ref<BoneReview[]>([])
const filters = ref<Record<string, string>>({ code: '', species: '' })
const message = ref('')
const messageOk = ref(false)

const statuses = ['未提交', '待复核', '复核通过', '复核拒绝']
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count:
      status === '未提交'
        ? views.value.filter((item) => !item.review).length
        : views.value.filter((item) => item.review?.status === status).length,
  })),
)

const filteredViews = computed(() =>
  views.value.filter((item) => {
    const codeHit = !filters.value.code || String(item.row.标本编号).includes(filters.value.code.trim())
    const speciesHit =
      !filters.value.species ||
      String(item.result?.种属判定 ?? '').includes(filters.value.species.trim())
    return codeHit && speciesHit
  }),
)

const pendingReviews = computed(() => reviews.value.filter((item) => item.status === '待复核'))
const pendingIntakeCount = computed(() => views.value.filter((item) => item.intake && !item.ledger).length)

function batchLabel(batchId: number | null): string {
  if (batchId === null) {
    return ''
  }
  return batches.value.find((batch) => batch.id === batchId)?.批次编号 ?? `批次#${batchId}`
}

function formatTime(value: string | null): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function resetFilters() {
  filters.value = { code: '', species: '' }
}

function reload() {
  views.value = specimenViews()
  batches.value = listBatches()
  reviews.value = listReviews()
}

// -- 人工单件结论弹窗 -------------------------------------------------------

const manualDialog = reactive({
  open: false,
  specimenId: 0,
  code: '',
  species: '',
  part: '',
  count: 0,
  mni: 0,
  expert: '值班鉴定人',
})

function openManual(item: SpecimenView) {
  manualDialog.open = true
  manualDialog.specimenId = Number(item.row.id)
  manualDialog.code = String(item.row.标本编号)
  manualDialog.species = item.result?.种属判定 ?? ''
  manualDialog.part = item.result?.骨骼部位 ?? ''
  manualDialog.count = item.result?.数量统计 ?? (Number(item.row.数量统计) || 0)
  manualDialog.mni = item.result?.最小个体数 ?? (Number(item.row.最小个体数) || 0)
}

function submitManual() {
  const receipt = submitManualResult({
    specimenId: manualDialog.specimenId,
    种属判定: manualDialog.species,
    骨骼部位: manualDialog.part,
    数量统计: manualDialog.count,
    最小个体数: manualDialog.mni,
    鉴定人: manualDialog.expert,
  })
  notify(receipt.ok, receipt.message)
  if (receipt.ok) {
    manualDialog.open = false
    reload()
  }
}

// -- 批次创建与提交弹窗 -----------------------------------------------------

interface BatchCandidate {
  specimenId: number
  code: string
  unit: string
  checked: boolean
  alreadyHasResult: boolean
  existingSource: string
  existingSpecies: string
  species: string
}

const batchDialog = reactive({
  open: false,
  batchId: 0,
  code: '',
  candidates: [] as BatchCandidate[],
})

function createNewBatch() {
  const batch = createBatch('值班鉴定人')
  notify(true, `已新建批次「${batch.批次编号}」，状态为鉴定中`)
  reload()
}

function openBatchSubmit(batch: BoneBatch) {
  const inBatch = new Set(batch.items.map((item) => item.specimenId))
  batchDialog.open = true
  batchDialog.batchId = batch.id
  batchDialog.code = batch.批次编号
  batchDialog.candidates = views.value
    .filter((item) => !inBatch.has(Number(item.row.id)))
    .map((item) => ({
      specimenId: Number(item.row.id),
      code: String(item.row.标本编号),
      unit: String(item.row.出土单位 ?? ''),
      checked: false,
      alreadyHasResult: Boolean(item.result),
      existingSource: item.result?.source ?? '',
      existingSpecies: item.result?.种属判定 ?? '',
      species: '',
    }))
}

function submitBatchForm() {
  const picked = batchDialog.candidates.filter((item) => item.checked && !item.alreadyHasResult)
  if (!picked.length) {
    notify(false, '请至少勾选一件尚无有效结论的标本')
    return
  }
  const receipt = submitBatch(
    batchDialog.batchId,
    picked.map((item) => ({ specimenId: item.specimenId, 种属判定: item.species })),
    '值班鉴定人',
  )
  notify(receipt.ok, receipt.message)
  if (receipt.ok) {
    batchDialog.open = false
  }
  reload()
}

// -- 复核 -------------------------------------------------------------------

function decide(review: BoneReview, pass: boolean) {
  const opinion = pass ? '同意鉴定结论' : window.prompt('请输入复核拒绝意见', '种属存疑，退回重鉴')
  if (!pass && opinion === null) {
    return
  }
  const receipt = decideReview({
    reviewId: review.id,
    pass,
    reviewer: '值班复核人',
    opinion: opinion ?? undefined,
  })
  notify(receipt.ok, receipt.message)
  reload()
}

function resetDomain() {
  resetBoneDomain()
  notify(true, '鉴定域数据已恢复为示例数据')
  reload()
}

onMounted(reload)
</script>

<style scoped>
.section-title { margin: 22px 0 8px; font-size: 15px; }
.batch-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.hint { color: var(--muted); font-size: 12px; }
.ok-text { color: #1a7f37; }
.source-tag { border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.source-tag.batch { background: #e8f0fe; color: #1f6feb; }
.source-tag.manual { background: #fef3e2; color: #b54708; }
.item-chip { display: inline-block; margin: 0 6px 4px 0; background: #eef2f7; border-radius: 4px; padding: 1px 6px; font-size: 12px; }
.item-chip.superseded { background: #fdecec; color: #b42318; text-decoration: line-through; }
.link.danger { color: #b42318; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal-card { background: #fff; border-radius: 10px; padding: 18px 20px; width: 680px; max-height: 82vh; overflow: auto; }
.modal-card h4 { margin: 0 0 6px; }
.modal-card label { display: block; margin: 8px 0; font-size: 13px; }
.modal-card label span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 2px; }
.modal-card input { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.data-table.inner { margin: 8px 0; }
</style>
