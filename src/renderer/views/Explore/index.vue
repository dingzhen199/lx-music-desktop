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
            <base-input :class="$style.input" :model-value="sessionView.instruction" :placeholder="t('explore__instruction_tip')" @update:model-value="handleInstructionChange" />
          </div>
        </div>

        <!-- 引擎/续补状态 -->
        <div :class="$style.status">
          <span v-if="refillState === 'refilling'">{{ t('explore__refilling') }}</span>
          <span v-else-if="refillState === 'retrying'">{{ t('explore__retrying') }}</span>
          <span v-else-if="lastErrorText">{{ lastErrorKind === 'refill' ? t('explore__refill_failed') : t('explore__plan_failed') }}</span>
          <span v-else-if="lastResultEngine">{{ lastResultEngine === 'ai' ? t('explore__engine_ai') : t('explore__engine_local') }}</span>
        </div>

        <!-- 反馈 -->
        <div :class="$style.feedback">
          <button :class="$style.btn" @click="handleFeedback('good')">{{ t('explore__feedback_good') }}</button>
          <button :class="$style.btn" @click="handleFeedback('far')">{{ t('explore__feedback_far') }}</button>
        </div>
      </div>

      <!-- 路径列表 -->
      <div :class="$style.pathWrap">
        <div :class="$style.pathTitle">{{ t('explore__path') }}</div>
        <div v-if="!sessionView.path.length" :class="$style.pathEmpty">{{ t('explore__path_empty') }}</div>
        <div v-for="item in pathItems" :key="item.key" :class="[$style.pathItem, { [$style.current]: item.isCurrent, [$style.played]: item.state === 'played' }]">
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
  lastErrorKind,
  lastErrorText,
  lastResultEngine,
  refillState,
  sessionView,
  setInstruction,
  setRadius,
  startSession,
} from '@renderer/core/recommend/session'
import { debounce } from '@common/utils'

const t = useI18n()

const anchorPicError = ref(false)

watch(() => sessionView.value.active, (active) => {
  if (active) anchorPicError.value = false
})

const hasPlaying = computed(() => Boolean(playMusicInfo.musicInfo?.id))

// 路径列表视图项：预计算序号与稳定 key，避免模板内模板字符串/索引运算（dev ts-loader 类型检查）
const pathItems = computed(() => sessionView.value.path.map((item, i) => ({ ...item, no: i + 1, key: item.id ?? `path-${i}` })))

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

const handleFeedback = (kind: 'far' | 'good') => {
  applyFeedback(kind)
}

const handleRadiusChange = debounce((value: number) => {
  setRadius(Number(value))
}, 300)

const handleInstructionChange = debounce((value: string) => {
  setInstruction(value)
}, 500)
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
}

.status {
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-font-label);
  min-height: 16px;
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
