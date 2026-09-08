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
    .p.small
      | {{ $t('setting__ai_tip') }}

  h3#recommend_default {{ $t('setting__recommend') }}
  div
    .p
      | {{ $t('setting__recommend_radius') }}
      base-slider-bar.gap-left(:class="$style.radiusSlider" :value="appSetting['recommend.radius']" :min="10" :max="90" :step="5" @change="setRadius")
      span.gap-left {{ appSetting['recommend.radius'] }}
    .p
      base-checkbox(id="setting_recommend_auto_refill" :model-value="appSetting['recommend.autoRefill']" :label="$t('setting__recommend_auto_refill')" @update:model-value="updateSetting({ 'recommend.autoRefill': $event })")
</template>

<script>
import { appSetting, updateSetting } from '@renderer/store/setting'
import { debounce } from '@common/utils'
import { useI18n } from '@renderer/plugins/i18n'

export default {
  name: 'SettingAi',
  setup() {
    const t = useI18n()
    const providerList = [
      { id: 'openai-compatible', name: 'OpenAI-compatible' },
      { id: 'anthropic', name: 'Anthropic' },
    ]
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

    return {
      appSetting,
      updateSetting,
      t,
      providerList,
      setBaseUrl,
      setApiKey,
      setModel,
      setRadius,
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
</style>
