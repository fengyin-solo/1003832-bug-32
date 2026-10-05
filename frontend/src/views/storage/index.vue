<template>
  <section class="page" data-module="storage">
    <header class="page-head">
      <div>
        <h2>库房管理</h2>
        <p class="page-desc">待入藏事项由动物骨骼复核通过时按当时复核结果生成，一件标本一条；架位台账在事项上架后写入，与鉴定列表共用同一取数口径，不再从鉴定批次重复派生。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="resetIntake">恢复库房派生示例</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待入藏事项</span>
        <strong class="stat-value">{{ pendingIntakes.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已入藏标本</span>
        <strong class="stat-value">{{ ledger.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">在台账架位</span>
        <strong class="stat-value">{{ shelfCount }}</strong>
      </article>
    </div>

    <h3 class="section-title">库房待入藏事项</h3>
    <div class="batch-bar">
      <button class="btn primary" type="button" :disabled="!selected.size" @click="shelfSelected">
        选中项上架（{{ selected.size }}）
      </button>
      <input v-model="shelfInput" class="shelf-input" placeholder="统一登记架位编号，如 DONG-02-B-01" />
      <span class="hint">多件一起上架时任一件失败则整批回退，不生成半份台账；重复上架会被拒绝。</span>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>选</th>
          <th>事项编号</th>
          <th>标本编号</th>
          <th>种属判定（复核时口径）</th>
          <th>骨骼部位</th>
          <th>数量</th>
          <th>来源批次</th>
          <th>生成时间</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in intakes" :key="item.id">
          <td><input v-if="item.status === '待入藏'" type="checkbox" :checked="selected.has(item.id)" @change="toggle(item.id)" /></td>
          <td>{{ item.id }}</td>
          <td>{{ item.标本编号 }}</td>
          <td>{{ item.种属判定 }}</td>
          <td>{{ item.骨骼部位 }}</td>
          <td>{{ item.数量统计 }}</td>
          <td>{{ item.来源批次 ? batchLabel(item.来源批次) : '人工单件' }}</td>
          <td>{{ formatTime(item.生成时间) }}</td>
          <td>{{ item.status }}</td>
        </tr>
        <tr v-if="!intakes.length">
          <td colspan="9" class="empty-state">暂无待入藏事项，复核通过后才会生成</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">架位台账</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>台账编号</th>
          <th>标本编号</th>
          <th>种属判定</th>
          <th>架位编号</th>
          <th>上架时间</th>
          <th>操作人</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in ledger" :key="entry.id">
          <td>{{ entry.id }}</td>
          <td>{{ entry.标本编号 }}</td>
          <td>{{ entry.种属判定 }}</td>
          <td>{{ entry.架位编号 }}</td>
          <td>{{ formatTime(entry.上架时间) }}</td>
          <td>{{ entry.操作人 }}</td>
        </tr>
        <tr v-if="!ledger.length">
          <td colspan="6" class="empty-state">暂无架位台账</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>待入藏 {{ pendingIntakes.length }} 条 · 台账 {{ ledger.length }} 条（均按标本去重）</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  listBatches,
  listIntakes,
  listLedger,
  placeIntakes,
  resetBoneDomain,
} from '@/api/bone-service'
import type { BoneBatch, StorageIntake, StorageLedgerEntry } from '@/data/bone-types'

const intakes = ref<StorageIntake[]>([])
const ledger = ref<StorageLedgerEntry[]>([])
const batches = ref<BoneBatch[]>([])
const selected = ref<Set<number>>(new Set())
const shelfInput = ref('')
const message = ref('')
const messageOk = ref(false)

const pendingIntakes = computed(() => intakes.value.filter((item) => item.status === '待入藏'))
const shelfCount = computed(() => new Set(ledger.value.map((item) => item.架位编号)).size)

function batchLabel(batchId: number): string {
  return batches.value.find((batch) => batch.id === batchId)?.批次编号 ?? `批次#${batchId}`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function toggle(id: number) {
  const next = new Set(selected.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selected.value = next
}

function shelfSelected() {
  if (!shelfInput.value.trim()) {
    messageOk.value = false
    message.value = '请填写架位编号后再上架'
    return
  }
  // 同一事务内逐件写入：任何一件重复或缺失都会整体回退，台账要么全有要么全无。
  const receipt = placeIntakes(
    [...selected.value].map((intakeId) => ({
      intakeId,
      架位编号: shelfInput.value,
      操作人: '值班库管',
    })),
  )
  messageOk.value = receipt.ok
  message.value = receipt.message
  if (receipt.ok) {
    selected.value = new Set()
    shelfInput.value = ''
  }
  reload()
}

function resetIntake() {
  resetBoneDomain()
  messageOk.value = true
  message.value = '待入藏与台账已恢复为示例数据'
  reload()
}

function reload() {
  intakes.value = listIntakes()
  ledger.value = listLedger()
  batches.value = listBatches()
}

onMounted(reload)
</script>

<style scoped>
.section-title { margin: 22px 0 8px; font-size: 15px; }
.batch-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.shelf-input { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; width: 260px; }
.hint { color: var(--muted); font-size: 12px; }
.ok-text { color: #1a7f37; }
</style>
