<template>
  <div :class="$style.explore">
    <!-- 无会话：空态 / 开始入口 -->
    <div v-if="!sessionView.active" :class="$style.empty">
      <p v-if="lastErrorText" :class="$style.error">{{ lastErrorText }}</p>
      <p>{{ hasPlaying ? t('explore__ready_tip') : t('explore__no_playing') }}</p>
      <button :class="[$style.btn, { [$style.disabled]: !hasPlaying }]" :disabled="!hasPlaying" @click="handleStart">
        {{ t('explore__start') }}
      </button>
    </div>

    <template v-else>
      <!-- 会话卡片 -->
      <div :class="$style.card">
        <div :class="$style.cardHeader">
          <div :class="$style.anchor">
            <img v-if="sessionView.anchor.pic && !anchorPicError" :src="sessionView.anchor.pic" :class="$style.anchorPic" decoding="async" alt="" @error="anchorPicError = true">
            <div v-else :class="$style.emptyPic"><span>L</span><span>X</span></div>
            <div :class="$style.anchorMeta">
              <div :class="$style.youAreHere">{{ t('explore__you_are_here') }}</div>
              <div :class="$style.anchorTitle">{{ sessionView.anchor.title }}</div>
              <div :class="$style.anchorArtist">{{ sessionView.anchor.artist }}</div>
            </div>
          </div>
          <div :class="$style.cardActions">
            <span :class="$style.remaining">{{ t('explore__remaining', { count: sessionView.remaining }) }}</span>
            <button :class="[$style.btn, $style.endBtn]" @click="handleEnd">{{ t('explore__end') }}</button>
          </div>
        </div>

        <!-- 距离滑杆 + 一句话约束 -->
        <div :class="$style.controls">
          <div :class="$style.row">
            <span :class="$style.label">{{ t('explore__distance') }}</span>
            <div :class="$style.radiusSlider">
              <base-slider-bar :class="$style.sliderBar" :value="sessionView.radius" :min="10" :max="90" :step="5" @change="handleRadiusChange" />
            </div>
            <span :class="$style.distanceWords">{{ distanceWords }}</span>
          </div>
          <div :class="$style.row">
            <span :class="$style.label">{{ t('explore__instruction') }}</span>
            <base-input :class="$style.input" :model-value="instructionDraft" :placeholder="t('explore__instruction_tip')" @update:model-value="instructionDraft = $event" @submit="handleInstructionSend" />
            <button :class="[$style.btn, $style.sendBtn]" @click="handleInstructionSend">{{ t('explore__instruction_send') }}</button>
          </div>
        </div>

        <!-- 引擎/续补状态 -->
        <div :class="$style.status">
          <span v-if="refillState === 'refilling'">{{ t('explore__refilling') }}</span>
          <span v-else-if="refillState === 'retrying'">{{ t('explore__retrying') }}</span>
          <span v-else-if="lastErrorText">{{ lastErrorKind === 'refill' ? t('explore__refill_failed') : t('explore__plan_failed') }}</span>
          <span v-else-if="lastResultEngine">{{ lastResultEngine === 'ai' ? t('explore__engine_ai') : t('explore__engine_local') }}</span>
          <!-- 本地计划时展示 AI 排序失败原因，让失败可见 -->
          <div v-if="lastResultEngine === 'local' && lastAiRankError" :class="$style.aiRankError">
            {{ t('explore__ai_rank_failed') }}{{ truncateText(lastAiRankError, 200) }}
          </div>
        </div>

        <!-- 反馈 -->
        <div :class="$style.feedback">
          <button :class="$style.btn" @click="handleFeedback('good')">{{ t('explore__feedback_good') }}</button>
          <button :class="$style.btn" @click="handleFeedback('far')">{{ t('explore__feedback_far') }}</button>
        </div>
      </div>

      <!-- 路径列表（按计划批次分组展示，行结构不变） -->
      <div :class="$style.pathWrap">
        <div :class="$style.pathTitle">{{ t('explore__path') }}</div>
        <div v-if="!sessionView.path.length" :class="$style.pathEmpty">{{ t('explore__path_empty') }}</div>
        <div v-for="batch in pathBatches" :key="batch.key" :class="$style.pathBatch">
          <div :class="$style.batchHeader">{{ batch.header }}</div>
          <div v-for="item in batch.items" :key="item.key" :class="[$style.pathItem, { [$style.current]: item.isCurrent, [$style.played]: item.state === 'played', [$style.clickable]: item.id != null }]" @click="handlePathClick(item.id)">
            <div :class="$style.pathIndex">{{ item.no }}</div>
            <div :class="$style.pathMain">
              <div :class="$style.pathName">
                <span :class="$style.title">{{ item.title }}</span>
                <span v-if="item.artist" :class="$style.artist"> - {{ item.artist }}</span>
              </div>
              <div :class="$style.reason">{{ item.reason }}</div>
            </div>
            <span :class="[$style.role, $style[`role_${item.journeyRole}`]]">{{ roleLabel(item.journeyRole) }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { playMusicInfo } from '@renderer/store/player/state'
import {
  applyFeedback,
  endSession,
  lastAiRankError,
  lastErrorKind,
  lastErrorText,
  lastResultEngine,
  playPathItem,
  refillState,
  sessionView,
  setInstruction,
  setRadius,
  startSession,
} from '@renderer/core/recommend/session'
import { debounce } from '@common/utils'
import type { SessionPathItem } from '@renderer/core/recommend/session-core'

const t = useI18n()

const anchorPicError = ref(false)
// 一句话约束草稿：受控本地值，点击“发送”/按 Enter 才提交（不再 debounce 自动重排）
const instructionDraft = ref('')

watch(() => sessionView.value.active, (active) => {
  if (!active) return
  anchorPicError.value = false
  // 会话（重）开始时草稿复位为会话当前约束（初始空串/重开）
  instructionDraft.value = sessionView.value.instruction
})

// 约束被提交（setInstruction）后草稿与会话约束同步；打字过程中不被打断（其他视图更新不动草稿）
watch(() => sessionView.value.instruction, (instruction) => {
  if (sessionView.value.active) instructionDraft.value = instruction
})

const hasPlaying = computed(() => Boolean(playMusicInfo.musicInfo?.id))

// 路径列表视图项：预计算序号与稳定 key，避免模板内模板字符串/索引运算（dev ts-loader 类型检查）
const pathItems = computed(() => sessionView.value.path.map((item, i) => ({ ...item, no: i + 1, key: item.id ?? `path-${i}` })))

// 注：类型别名引用 imported 类型而非本地 const（compileScript 会把顶层 type 提到 setup 之外）。
type PathViewItem = SessionPathItem & { isCurrent: boolean, no: number, key: string }

/** 批次条件快照 → 分组 key（连续相同的 batch 归一组的依据；无 batch 为 null）。 */
const batchKeyOf = (item: PathViewItem): string | null => {
  const b = item.batch
  return b ? `${b.radius}|||${b.instruction}|||${b.engine}` : null
}

/** 组头文案：第 N 批 · 距离 {radius} · 约束 {instruction} · {engine}（约束空/无 batch 用“无”兜底）。 */
const buildBatchHeader = (batch: PathViewItem['batch'], index: number): string => {
  const engine = batch ? t(batch.engine === 'ai' ? 'explore__engine_ai' : 'explore__engine_local') : ''
  return t('explore__path_batch_header', {
    index,
    radius: batch ? batch.radius : '—',
    instruction: batch && String(batch.instruction ?? '').trim() ? batch.instruction : t('explore__path_batch_none'),
    engine: engine || '—',
  })
}

/**
 * 路径分批：按计划批次连续分桶（连续相同条件并成一组）；
 * 无 batch 的历史条目归入上一组（没有上一组则自成默认组）。
 * 组头是额外元素，组内行结构（pathItem 及角色徽章父子关系）不变，不影响路径点击探针。
 */
const pathBatches = computed(() => {
  const groups: Array<{ key: string, header: string, items: PathViewItem[] }> = []
  let lastKey: string | null = null
  for (const item of pathItems.value) {
    const key = batchKeyOf(item)
    if (key == null) {
      if (groups.length) groups[groups.length - 1].items.push(item)
      else groups.push({ key: '', header: '', items: [item] })
      continue
    }
    if (key !== lastKey) {
      groups.push({ key, header: '', items: [] })
      lastKey = key
    }
    groups[groups.length - 1].items.push(item)
  }
  return groups.map((group, gi) => ({
    ...group,
    key: `${gi}-${group.key}`,
    header: buildBatchHeader(group.items[0]?.batch, gi + 1),
  }))
})

const distanceWords = computed(() => {
  const radius = sessionView.value.radius
  if (radius <= 20) return t('explore__distance_near')
  if (radius <= 42) return t('explore__distance_medium')
  if (radius <= 65) return t('explore__distance_far')
  return t('explore__distance_farthest')
})

const roleLabel = (role: string): string => {
  switch (role) {
    case 'hold': return t('explore__role_hold')
    case 'deepen': return t('explore__role_deepen')
    case 'turn': return t('explore__role_turn')
    case 'land': return t('explore__role_land')
    default: return t('explore__role_open')
  }
}

const handleStart = async() => {
  try {
    await startSession()
  } catch (err) {
    console.warn('[explore] 开始会话失败', (err as Error).message)
  }
}

const handleEnd = () => {
  endSession()
}

const handlePathClick = (id: string | null) => {
  playPathItem(id)
}

const truncateText = (text: string, max: number): string => {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

const handleFeedback = (kind: 'far' | 'good') => {
  applyFeedback(kind)
}

const handleRadiusChange = debounce((value: number) => {
  setRadius(Number(value))
}, 300)

// 发送按钮 / 输入框 Enter：提交一句话约束（草稿受控本地值，不自动重排）
const handleInstructionSend = () => {
  setInstruction(instructionDraft.value)
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.explore {
  overflow-y: auto;
  height: 100%;
  padding: 20px;
  box-sizing: border-box;
  color: var(--color-font);
}

.empty {
  height: 100%;
  display: flex;
  flex-flow: column nowrap;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-size: 14px;
  text-align: center;
  .error {
    color: var(--color-badge-secondary);
    max-width: 80%;
  }
}

.btn {
  border: none;
  border-radius: @radius-border;
  background-color: var(--color-primary-background);
  color: var(--color-button-font);
  font-size: 13px;
  padding: 7px 14px;
  cursor: pointer;
  transition: @transition-fast;
  transition-property: background-color, opacity;
  &:hover {
    background-color: var(--color-primary-background-hover);
  }
  &:active {
    background-color: var(--color-primary-background-active);
  }
  &.disabled, &[disabled] {
    opacity: .4;
    cursor: default;
  }
}

.card {
  background-color: var(--color-primary-light-200-alpha-600);
  border-radius: @radius-border;
  padding: 14px 16px;
  margin-bottom: 14px;
}

.cardHeader {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  justify-content: space-between;
}

.anchor {
  min-width: 0;
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 10px;
}

.anchorPic {
  width: 46px;
  height: 46px;
  border-radius: @radius-border;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.3);
  flex: none;
}

.emptyPic {
  width: 46px;
  height: 46px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--color-primary-light-900-alpha-200);
  border-radius: @radius-border;
  color: var(--color-primary-light-400-alpha-200);
  font-size: 16px;
  font-family: Consolas, 'Courier New', monospace;
}

.anchorMeta {
  min-width: 0;
  .youAreHere {
    font-size: 11px;
    color: var(--color-primary);
  }
  .anchorTitle {
    font-size: 14px;
    .mixin-ellipsis-1();
    max-width: 40vw;
  }
  .anchorArtist {
    font-size: 12px;
    color: var(--color-font-label);
    .mixin-ellipsis-1();
    max-width: 40vw;
  }
}

.cardActions {
  flex: none;
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 12px;
  .remaining {
    font-size: 12px;
    color: var(--color-font-label);
  }
}

.controls {
  margin-top: 12px;
  .row {
    display: flex;
    flex-flow: row nowrap;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .label {
    flex: none;
    font-size: 12px;
    color: var(--color-font-label);
    width: 64px;
  }
  .radiusSlider {
    flex: auto;
    max-width: 300px;
    min-width: 120px;
  }
  .sliderBar {
    width: 100%;
  }
  .distanceWords {
    flex: none;
    font-size: 12px;
    color: var(--color-font);
  }
  .input {
    flex: auto;
    max-width: 300px;
  }
  .sendBtn {
    flex: none;
  }
}

.status {
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-font-label);
  min-height: 16px;
  .aiRankError {
    margin-top: 4px;
    color: var(--color-badge-secondary);
  }
}

.feedback {
  margin-top: 8px;
  display: flex;
  flex-flow: row nowrap;
  gap: 10px;
}

.pathWrap {
  .pathTitle {
    font-size: 14px;
    margin-bottom: 10px;
  }
  .pathEmpty {
    font-size: 12px;
    color: var(--color-font-label);
  }
}

.pathBatch {
  .batchHeader {
    font-size: 12px;
    color: var(--color-font-label);
    margin: 10px 0 6px;
    padding-left: 2px;
  }
}

.pathItem {
  display: flex;
  flex-flow: row nowrap;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: @radius-border;
  margin-bottom: 6px;
  background-color: var(--color-primary-light-200-alpha-400);
  &.current {
    background-color: var(--color-primary-light-300-alpha-700);
  }
  &.played {
    opacity: .75;
  }
  &.clickable {
    cursor: pointer;
    transition: background-color @transition-fast;
    &:hover {
      background-color: var(--color-primary-light-300-alpha-500);
    }
  }
}

.pathIndex {
  flex: none;
  width: 20px;
  line-height: 20px;
  text-align: center;
  font-size: 11px;
  color: var(--color-font-label);
}

.pathMain {
  flex: auto;
  min-width: 0;
  .pathName {
    .title {
      font-size: 13px;
    }
    .artist {
      font-size: 12px;
      color: var(--color-font-label);
    }
  }
  .reason {
    font-size: 12px;
    color: var(--color-font-label);
    margin-top: 2px;
  }
}

.role {
  flex: none;
  font-size: 11px;
  line-height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  color: var(--color-primary);
  background-color: var(--color-primary-light-300-alpha-700);
  &.role_turn {
    color: var(--color-badge-secondary);
  }
  &.role_land {
    color: var(--color-badge-tertiary);
  }
}
</style>
