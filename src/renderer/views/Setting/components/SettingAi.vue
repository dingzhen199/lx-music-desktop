<template lang="pug">
dt#ai {{ $t('setting__ai') }}
dd
  div
    .p
      base-checkbox(id="setting_ai_enable" :model-value="appSetting['ai.enable']" :label="$t('setting__ai_enable')" @update:model-value="updateSetting({ 'ai.enable': $event })")
    .p
      | {{ $t('setting__ai_provider') }}
      span.select
        base-selection(:model-value="appSetting['ai.provider']" :list="providerList" item-key="id" item-name="name" @update:model-value="updateSetting({ 'ai.provider': $event })")
    .p
      | {{ $t('setting__ai_base_url') }}
      base-input.gap-left(:model-value="appSetting['ai.baseUrl']" :placeholder="$t('setting__ai_base_url_tip')" @update:model-value="setBaseUrl")
    .p
      | {{ $t('setting__ai_api_key') }}
      base-input.gap-left(:model-value="appSetting['ai.apiKey']" type="password" :placeholder="$t('setting__ai_api_key_tip')" @update:model-value="setApiKey")
    .p
      | {{ $t('setting__ai_model') }}
      base-input.gap-left(:model-value="appSetting['ai.model']" :placeholder="$t('setting__ai_model_tip')" @update:model-value="setModel")
    .p
      | {{ $t('setting__ai_concurrency') }}
      span.select
        base-selection#setting_ai_concurrency(:model-value="concurrency" :list="concurrencyList" item-key="id" item-name="name" @update:model-value="setConcurrency")
    .p.small {{ $t('setting__ai_concurrency_tip') }}
    .p
      base-btn.btn(min :disabled="aiTestState === 'testing'" @click="handleTestConnect") {{ $t('setting__ai_test_btn') }}
      span.gap-left(:class="{ [$style.testing]: aiTestState === 'testing', [$style.ok]: aiTestState === 'ok', [$style.fail]: aiTestState === 'fail' || aiTestState === 'needConfig' }") {{ aiTestText }}
    .p.small
      | {{ $t('setting__ai_tip') }}

  h3#recommend_default {{ $t('setting__recommend') }}
  div
    .p.small
      | {{ $t('setting__recommend_tip') }}
    .p(v-if="!isPlatformEngine")
      | {{ $t('setting__recommend_radius') }}
      base-slider-bar.gap-left(:class="$style.radiusSlider" :value="appSetting['recommend.radius']" :min="10" :max="90" :step="5" @change="setRadius")
      span.gap-left {{ appSetting['recommend.radius'] }}
    .p
      base-checkbox(id="setting_recommend_auto_refill" :model-value="appSetting['recommend.autoRefill']" :label="$t('setting__recommend_auto_refill')" @update:model-value="updateSetting({ 'recommend.autoRefill': $event })")
    .p
      base-checkbox(id="setting_recommend_radio" :model-value="appSetting['recommend.radio']" :label="$t('setting__recommend_radio')" @update:model-value="updateSetting({ 'recommend.radio': $event })")
</template>

<script>
import { appSetting, updateSetting } from '@renderer/store/setting'
import { debounce } from '@common/utils'
import { computed, ref } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { LLM_MAX_CONCURRENCY, normalizeLlmConcurrency, normalizeRecommendEngine } from '@common/recommendationConfig'
import { llmComplete } from '@renderer/core/recommend/llm'

export default {
  name: 'SettingAi',
  setup() {
    const t = useI18n()
    const providerList = [
      { id: 'openai-compatible', name: 'OpenAI-compatible' },
      { id: 'anthropic', name: 'Anthropic' },
    ]
    const concurrency = computed(() => normalizeLlmConcurrency(appSetting['ai.maxConcurrentRequests']))
    const isPlatformEngine = computed(() => normalizeRecommendEngine(appSetting['recommend.engine']) === 'platform')
    const concurrencyList = Array.from({ length: LLM_MAX_CONCURRENCY }, (_, i) => ({ id: i + 1, name: String(i + 1) }))
    const setConcurrency = value => { updateSetting({ 'ai.maxConcurrentRequests': normalizeLlmConcurrency(value) }) }
    const setBaseUrl = debounce(value => {
      updateSetting({ 'ai.baseUrl': value.trim() })
    }, 500)
    const setApiKey = debounce(value => {
      updateSetting({ 'ai.apiKey': value.trim() })
    }, 500)
    const setModel = debounce(value => {
      updateSetting({ 'ai.model': value.trim() })
    }, 500)
    const setRadius = debounce(value => {
      updateSetting({ 'recommend.radius': Number(value) })
    }, 300)

    // 测试连接状态五态（idle/testing/ok/fail/needConfig；needConfig=缺少 Key/模型时的提示态）
    const aiTestState = ref('idle')
    const aiTestMessage = ref('')

    const aiTestText = computed(() => {
      switch (aiTestState.value) {
        case 'testing':
          return t('setting__ai_testing')
        case 'ok':
          return t('setting__ai_test_ok')
        case 'needConfig':
          return t('setting__ai_test_need_config')
        case 'fail':
          return `${t('setting__ai_test_fail_prefix')}${aiTestMessage.value}`
        default:
          return ''
      }
    })

    const handleTestConnect = async() => {
      if (aiTestState.value === 'testing') return
      const apiKey = appSetting['ai.apiKey']?.trim()
      const model = appSetting['ai.model']?.trim()
      if (!apiKey || !model) {
        aiTestState.value = 'needConfig'
        aiTestMessage.value = ''
        return
      }
      aiTestState.value = 'testing'
      aiTestMessage.value = ''
      try {
        await llmComplete({
          protocol: appSetting['ai.provider'],
          baseUrl: appSetting['ai.baseUrl']?.trim(),
          apiKey,
          model,
          messages: [{ role: 'user', content: '请只回复：OK' }],
        })
        aiTestState.value = 'ok'
      } catch (err) {
        aiTestState.value = 'fail'
        aiTestMessage.value = String(err?.message ?? err).slice(0, 300)
      }
    }

    return {
      appSetting,
      updateSetting,
      t,
      providerList,
      concurrency,
      isPlatformEngine,
      concurrencyList,
      setConcurrency,
      setBaseUrl,
      setApiKey,
      setModel,
      setRadius,
      aiTestState,
      aiTestText,
      handleTestConnect,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';
.radiusSlider {
  vertical-align: middle;
  display: inline-block;
  width: 160px;
}
.testing {
  color: var(--color-font-label);
}
.ok {
  color: var(--color-primary);
}
.fail {
  color: var(--color-badge-secondary);
}
</style>
