<template>
  <div class="page">
    <el-card shadow="never" class="header-card">
      <div class="header">
        <div>
          <h2>剧集运维</h2>
          <p class="hint">按 drama uuid 查集 / 缺镜 / 批次,一键补做 · 调用户端同源端点,无需改后端</p>
        </div>
        <div class="actions">
          <el-input
            v-model="uuidInput"
            placeholder="drama uuid"
            clearable
            style="width: 340px"
            @keyup.enter="query"
          />
          <el-button type="primary" :icon="Search" :loading="loading" @click="query">查询</el-button>
        </div>
      </div>
    </el-card>

    <el-alert
      v-if="busyText"
      :title="busyText"
      type="warning"
      :closable="false"
      show-icon
    />

    <el-card shadow="never" v-if="drama">
      <template #header>
        <div class="card-header">
          <span>{{ drama.title || '未命名剧集' }}</span>
          <span class="muted">{{ drama.uuid }}</span>
        </div>
      </template>
      <div class="runtime-grid">
        <div class="row"><span class="k">状态</span><span class="v">{{ drama.status }}</span></div>
        <div class="row"><span class="k">集数</span><span class="v">{{ episodes.length }}</span></div>
        <div class="row"><span class="k">批次</span><span class="v">{{ batches.length }}</span></div>
      </div>
    </el-card>

    <el-card shadow="never" v-if="drama">
      <template #header>
        <div class="card-header"><span>分集与缺镜</span></div>
      </template>
      <el-table :data="episodes" max-height="420">
        <el-table-column prop="epNo" label="集" width="60" />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'done' ? 'success' : 'warning'" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时长" width="90">
          <template #default="{ row }">{{ row.durationSec ?? '—' }}s</template>
        </el-table-column>
        <el-table-column label="计划/成片/缺" width="140">
          <template #default="{ row }">
            {{ step5(row)?.planned_shots ?? '—' }}/{{ step5(row)?.composed_shots ?? '—' }}/{{ step5(row)?.missing_shots ?? '—' }}
          </template>
        </el-table-column>
        <el-table-column label="缺镜点名(镜号:原因)" min-width="260">
          <template #default="{ row }">
            <div v-if="failedList(row).length">
              <div v-for="f in failedList(row)" :key="f.shot_idx" class="fail-line">
                <el-tag type="danger" size="small">#{{ f.shot_idx }}</el-tag>
                <span class="fail-reason">{{ f.reason || f.status }}</span>
              </div>
            </div>
            <span v-else class="muted">无</span>
          </template>
        </el-table-column>
        <el-table-column label="硬冻/近静止" width="130">
          <template #default="{ row }">
            <span v-if="auditShots(row).frozen.length" class="frozen">冻 {{ auditShots(row).frozen.join(',#') }}</span>
            <span v-else-if="auditShots(row).static.length" class="muted">静 {{ auditShots(row).static.join(',#') }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :disabled="busy || missingOf(row) === 0" @click="supplement(row)">
              补做缺镜
            </el-button>
            <el-button size="small" :disabled="busy" @click="recompose(row)">重合成</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" v-if="drama">
      <template #header>
        <div class="card-header">
          <span>生产批次</span>
          <el-button size="small" :icon="Refresh" :loading="loading" @click="query">刷新</el-button>
        </div>
      </template>
      <el-table :data="batches" max-height="320">
        <el-table-column label="batch" min-width="200">
          <template #default="{ row }"><span class="mono">{{ shortUuid(row.uuid) }}</span></template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'done' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'" size="small">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="游标" width="110">
          <template #default="{ row }">EP{{ row.cursorEp }}/s{{ row.cursorStep }}</template>
        </el-table-column>
        <el-table-column label="预算" width="110">
          <template #default="{ row }">{{ row.policy?.budgetCredits ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="最后动态" min-width="260">
          <template #default="{ row }"><span class="muted">{{ lastLog(row) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              :disabled="busy || !['paused', 'failed', 'cancelled'].includes(String(row.status))"
              @click="resume(row)"
            >
              续跑
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Search } from '@element-plus/icons-vue'
import { dramaApi, type DramaEpisodeLike, type DramaBatchLike } from '@/api/drama'

const uuidInput = ref(localStorage.getItem('dramaOpsUuid') || '')
const loading = ref(false)
const busy = ref(false)
const busyText = ref('')
const drama = ref<any>(null)
const episodes = ref<DramaEpisodeLike[]>([])
const batches = ref<DramaBatchLike[]>([])

function shortUuid(u: any): string {
  const s = String(u || '')
  return s.length > 13 ? s.slice(0, 8) + '…' : s
}

function step5(row: DramaEpisodeLike): any {
  return (row.stepData as any)?.['5']?.output || null
}

/** 缺镜清单:优先 step5.failed_shots(2026-09-24 点名),老数据回退按 step4 无 video_url 算 */
function failedList(row: DramaEpisodeLike): Array<{ shot_idx: number; status?: string; reason?: string }> {
  const named = step5(row)?.failed_shots
  if (Array.isArray(named) && named.length) return named
  const shots4 = (row.stepData as any)?.['4']?.output?.shots
  if (!Array.isArray(shots4)) return []
  return shots4
    .filter((s: any) => s && !s.video_url && Number.isFinite(Number(s.shot_idx)))
    .map((s: any) => ({ shot_idx: Number(s.shot_idx), status: s.status, reason: s.error || s.reason }))
}

function missingOf(row: DramaEpisodeLike): number {
  const m = Number(step5(row)?.missing_shots)
  if (Number.isFinite(m)) return m
  return failedList(row).length
}

/** 质检点名到镜号(新) — 老数据无 audit_shots 时显示 — */
function auditShots(row: DramaEpisodeLike): { static: number[]; frozen: number[] } {
  const a = step5(row)?.audit_shots
  return {
    static: Array.isArray(a?.static) ? a.static : [],
    frozen: Array.isArray(a?.frozen) ? a.frozen : [],
  }
}

function lastLog(row: DramaBatchLike): string {
  const l = Array.isArray(row.log) && row.log.length ? row.log[row.log.length - 1] : null
  return l?.msg ? String(l.msg).slice(0, 80) : '—'
}

async function query() {
  const uuid = uuidInput.value.trim()
  if (!uuid) {
    ElMessage.warning('先填 drama uuid')
    return
  }
  localStorage.setItem('dramaOpsUuid', uuid)
  loading.value = true
  try {
    const [d, eps, bs] = await Promise.all([
      dramaApi.getDrama(uuid).catch(() => null),
      dramaApi.getEpisodes(uuid).catch(() => []),
      dramaApi.getBatches(uuid).catch(() => []),
    ])
    drama.value = d
    episodes.value = (Array.isArray(eps) ? eps : []).slice().sort((a, b) => Number(a.epNo) - Number(b.epNo))
    batches.value = Array.isArray(bs) ? bs : []
    if (!d) ElMessage.error('查不到该剧(确认 uuid 与后端连通)')
  } finally {
    loading.value = false
  }
}

/** 补做缺镜:重跑 step4(成功镜复用) + step5 重合成,与 App 端一键补做同语义 */
async function supplement(row: DramaEpisodeLike) {
  const uuid = uuidInput.value.trim()
  const epNo = Number(row.epNo)
  busy.value = true
  try {
    busyText.value = `EP${epNo} step4 补视频中(分钟级,成功镜自动复用)…`
    await dramaApi.generateStep(uuid, epNo, 4, {})
    busyText.value = `EP${epNo} step5 重合成中…`
    await dramaApi.generateStep(uuid, epNo, 5, {})
    ElMessage.success('补做完成,已刷新')
  } catch (e: any) {
    ElMessage.error(`补做失败:${e?.message || e}`)
  } finally {
    busy.value = false
    busyText.value = ''
    await query()
  }
}

async function recompose(row: DramaEpisodeLike) {
  const uuid = uuidInput.value.trim()
  const epNo = Number(row.epNo)
  busy.value = true
  try {
    busyText.value = `EP${epNo} step5 重合成中…`
    await dramaApi.generateStep(uuid, epNo, 5, {})
    ElMessage.success('重合成完成,已刷新')
  } catch (e: any) {
    ElMessage.error(`重合成失败:${e?.message || e}`)
  } finally {
    busy.value = false
    busyText.value = ''
    await query()
  }
}

async function resume(row: DramaBatchLike) {
  busy.value = true
  try {
    busyText.value = `批次 ${shortUuid(row.uuid)} 续跑中…`
    await dramaApi.resumeBatch(String(row.uuid))
    ElMessage.success('已续跑')
  } catch (e: any) {
    ElMessage.error(`续跑失败:${e?.message || e}`)
  } finally {
    busy.value = false
    busyText.value = ''
    await query()
  }
}
</script>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.header-card { }
.header { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.header h2 { margin: 0 0 4px; font-size: 20px; }
.hint { margin: 0; color: #909399; font-size: 12px; }
.actions { display: flex; gap: 8px; align-items: center; }
.card-header { display: flex; justify-content: space-between; align-items: center; }
.muted { color: #909399; font-size: 12px; }
.mono { font-family: monospace; font-size: 12px; }
.runtime-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 24px; font-size: 13px; }
.row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dashed #eee; }
.k { color: #909399; }
.v { color: #303133; font-weight: 600; }
.fail-line { display: flex; gap: 6px; align-items: baseline; margin: 2px 0; }
.fail-reason { font-size: 12px; color: #606266; word-break: break-all; }
.frozen { color: #e6a23c; font-weight: 700; font-size: 12px; }
</style>
