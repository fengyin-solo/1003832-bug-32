<template>
  <section class="page" data-module="animal_bone">
    <header class="page-head">
      <div>
        <h2>动物骨骼管理</h2>
        <p class="page-desc">维护动物骨骼标本，围绕标本编号、出土单位、种属判定、骨骼部位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记动物骨骼标本</button>
        <button class="btn" type="button" @click="exportRows">导出动物骨骼清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无动物骨骼数据，可先登记动物骨骼标本</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条动物骨骼记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="sub-panel">
      <h3 class="sub-title">鉴定批次</h3>
      <p class="sub-desc">提交鉴定即生成批次；同一标本只认第一次有效结论，重复提交会被拒绝。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>提交时间</th>
            <th>提交人</th>
            <th>批次状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="String(batch.id)">
            <td>{{ batch['批次号'] }}</td>
            <td>{{ batch['提交时间'] }}</td>
            <td>{{ batch['提交人'] }}</td>
            <td>{{ batch.status }}</td>
            <td class="row-actions">
              <button
                v-if="batch.status === '待复核'"
                class="link"
                type="button"
                @click="reviewWholeBatch(batch)"
              >
                复核鉴定
              </button>
              <span v-else>—</span>
            </td>
          </tr>
          <tr v-if="!batches.length">
            <td colspan="5" class="empty-state">暂无鉴定批次，提交鉴定后自动生成</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="sub-panel">
      <h3 class="sub-title">复核记录</h3>
      <p class="sub-desc">与库房待入藏事项共用同一鉴定批次口径：一件标本只写一条，结论以复核时采用值为准。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>标本编号</th>
            <th>种属判定</th>
            <th>结论来源</th>
            <th>批次号</th>
            <th>复核时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="review in reviews" :key="String(review.id)">
            <td>{{ review['标本编号'] }}</td>
            <td>{{ review['种属判定'] }}</td>
            <td>{{ review['结论来源'] }}</td>
            <td>{{ review['批次号'] }}</td>
            <td>{{ review['复核时间'] }}</td>
          </tr>
          <tr v-if="!reviews.length">
            <td colspan="5" class="empty-state">暂无复核记录，复核鉴定后生成</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listBatches, listReviews, reviewBatch } from '@/api/identification'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('animal_bone')
const columns = ["标本编号", "出土单位", "种属判定", "骨骼部位", "数量统计", "最小个体数", "鉴定人", "鉴定状态"]
const actions = ["开始鉴定", "提交鉴定", "复核鉴定"]
const statuses = ["已采集", "鉴定中", "已鉴定", "已复核", "已归档"]
const stats = [{"label": "标本总数", "value": 0}, {"label": "已鉴定数", "value": 0}, {"label": "鉴定中数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const batches = ref<EntryRow[]>([])
const reviews = ref<EntryRow[]>([])
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '动物骨骼标本登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reviewWholeBatch(batch: EntryRow) {
  errorMessage.value = ''
  const result = reviewBatch(Number(batch.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    batches.value = listBatches()
    reviews.value = listReviews()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '动物骨骼列表读取失败'
  }
}

onMounted(reload)
</script>
