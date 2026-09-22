<template lang="pug">
material-modal(:show="modelValue" bg-close teleport="#view" @close="handleClose")
  main.scroll(:class="$style.main")
    h2 {{ $t('user_api__title') }}
    ul.scroll(v-show="apiList.length" ref="dom_list" :class="$style.content")
      li(v-for="(api, index) in apiList" :key="api.id" :class="[{ 'no-drag': !isBackup(api.id) }, $style.listItem, {[$style.active]: appSetting['common.apiSource'] == api.id, [$style.dragable]: isBackup(api.id)}]")
        div(:class="$style.listLeft")
          h3
            span(v-if="appSetting['common.apiSource'] == api.id" :class="$style.primaryTag") {{ $t('user_api__primary_label') }}
            | {{ api.name }}
            span(v-if="api.version") {{ /^\d/.test(api.version) ? `v${api.version}` : api.version }}
            span(v-if="api.author") {{ api.author }}
          p {{ api.description }}
          div
            base-checkbox(v-if="appSetting['common.apiSource'] != api.id" :id="`user_api_backup_${api.id}`" :model-value="isBackup(api.id)" :class="$style.checkbox" :label="$t('user_api__backup_label')" @change="handleToggleBackup(api, $event)")
            base-checkbox(:id="`user_api_${api.id}`" v-model="api.allowShowUpdateAlert" :class="$style.checkbox" :label="$t('user_api__allow_show_update_alert')" @change="handleChangeAllowUpdateAlert(api, $event)")
        base-btn(:class="$style.listBtn" outline :aria-label="$t('user_api__btn_remove')" @click.stop="handleRemove(index)")
          svg(v-once version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 212.982 212.982" space="preserve")
            use(xlink:href="#icon-delete")
    div(v-if="!apiList.length" :class="$style.content")
      div(:class="$style.noitem") {{ $t('user_api__noitem') }}
    div(:class="$style.note")
      p(:class="[$style.ruleLink]")
        | {{ $t('user_api__readme') }}
        span.hover.underline(aria-label="https://lxmusic.toside.cn/desktop/custom-source" @click="handleOpenUrl('https://lyswhut.github.io/lx-music-doc/desktop/custom-source')") FAQ
      p {{ $t('user_api__backup_tip') }}
      p {{ $t('user_api__note') }}
    div(:class="$style.footer")
      base-btn(:class="$style.footerBtn" @click="isShowOnlineImportModal = true") {{ $t('user_api__btn_import_online') }}
      base-btn(:class="$style.footerBtn" @click="handleImport") {{ $t('user_api__btn_import') }}
      //- base-btn(:class="$style.footerBtn" @click="handleExport") {{ $t('user_api__btn_export') }}
    UserApiOnlineImportModal(v-model:show="isShowOnlineImportModal" @import="importUserApi")
</template>

<script>
import { importUserApi, removeUserApi, showSelectDialog, setAllowShowUserApiUpdateAlert } from '@renderer/utils/ipc'
import { readFile } from '@common/utils/nodejs'
import { openUrl } from '@common/utils/electron'
import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { userApi } from '@renderer/store'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { computed, onMounted, ref, useCssModule } from '@common/utils/vueTools'
import { dialog } from '@renderer/plugins/Dialog'
import useDrag from '@renderer/utils/compositions/useDrag'
import { normalizeApiSourceBackups } from '@common/userApi'

import UserApiOnlineImportModal from './UserApiOnlineImportModal.vue'

export default {
  components: {
    UserApiOnlineImportModal,
  },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  setup() {
    const isShowOnlineImportModal = ref(false)
    const dom_list = ref(null)
    const styles = useCssModule()

    // 展示顺序即轮换顺序：主源 → 备源（按用户排序）→ 未启用
    const apiList = computed(() => {
      const primaryId = appSetting['common.apiSource']
      const backupIds = normalizeApiSourceBackups(primaryId, appSetting['common.apiSourceBackups'])
      const list = userApi.list
      const primary = list.filter(api => api.id == primaryId)
      const backups = backupIds.map(id => list.find(api => api.id == id)).filter(Boolean)
      const rest = list.filter(api => api.id != primaryId && !backupIds.includes(api.id))
      return [...primary, ...backups, ...rest]
    })

    const isBackup = (id) => id !== appSetting['common.apiSource'] && appSetting['common.apiSourceBackups'].includes(id)

    const handleToggleBackup = (api, enable) => {
      const ids = [...appSetting['common.apiSourceBackups']]
      const index = ids.indexOf(api.id)
      if (enable) {
        if (index < 0) ids.push(api.id)
      } else if (index > -1) ids.splice(index, 1)
      updateSetting({ 'common.apiSourceBackups': ids })
    }

    const drag = useDrag({
      dom_list,
      dragingItemClassName: styles.dragingItem,
      filter: 'no-drag',
      onUpdate(newIndex, oldIndex) {
        if (newIndex == oldIndex) return
        // 按拖拽后的展示顺序重排备源序列（主源与未启用源的位置不参与）
        const list = [...apiList.value]
        const [moved] = list.splice(oldIndex, 1)
        list.splice(newIndex, 0, moved)
        const primaryId = appSetting['common.apiSource']
        const backupIds = list.map(api => api.id).filter(id => id != primaryId && appSetting['common.apiSourceBackups'].includes(id))
        updateSetting({ 'common.apiSourceBackups': backupIds })
      },
    })
    onMounted(() => {
      drag.setDisabled(false)
    })

    return {
      userApi,
      apiList,
      appSetting,
      isShowOnlineImportModal,
      dom_list,
      isBackup,
      handleToggleBackup,
    }
  },
  methods: {
    async importUserApi(script) {
      return importUserApi(script).then(({ apiList }) => {
        userApi.list = apiList
      }).catch((err) => {
        void dialog(this.$t('user_api_import__failed', { message: err.message }))
      })
    },
    handleImport() {
      if (this.userApi.list.length > 20) {
        this.$dialog({
          message: this.$t('user_api__max_tip'),
          confirmButtonText: this.$t('ok'),
        })
        return
      }
      void showSelectDialog({
        title: this.$t('user_api__import_file'),
        properties: ['openFile'],
        filters: [
          { name: 'LX API File', extensions: ['js'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      }).then(async result => {
        if (result.canceled) return
        return readFile(result.filePaths[0]).then(async data => {
          return this.importUserApi(data.toString())
        })
      })
    },
    handleExport() {

    },
    async handleRemove(index) {
      const api = this.apiList[index]
      if (!api) return
      const backups = appSetting['common.apiSourceBackups'].filter(id => id != api.id)
      if (backups.length != appSetting['common.apiSourceBackups'].length) updateSetting({ 'common.apiSourceBackups': backups })
      if (appSetting['common.apiSource'] == api.id) {
        let backApi = apiSourceInfo.find(api => !api.disabled)
        if (!backApi) backApi = userApi.list[0]
        updateSetting({ 'common.apiSource': backApi?.id ?? '' })
      }
      userApi.list = await removeUserApi([api.id])
    },
    handleClose() {
      this.$emit('update:modelValue', false)
    },
    handleOpenUrl(url) {
      void openUrl(url)
    },
    handleChangeAllowUpdateAlert(api, enable) {
      void setAllowShowUserApiUpdateAlert(api.id, enable)
    },
  },
}
</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  padding: 15px 8px;
  max-width: 550px;
  min-width: 300px;
  display: flex;
  flex-flow: column nowrap;
  min-height: 0;
  // max-height: 100%;
  // overflow: hidden;
  h2 {
    font-size: 16px;
    color: var(--color-font);
    line-height: 1.3;
    text-align: center;
  }
}

.name {
  color: var(--color-primary);
}

.checkbox {
  margin-top: 3px;
  font-size: 14px;
  opacity: .86;
  + .checkbox {
    margin-left: 15px;
  }
}

.content {
  flex: auto;
  min-height: 80px;
  max-height: 100%;
  margin-top: 15px;
  padding: 0 7px;
}
.listItem {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  transition: background-color 0.2s ease;
  padding: 15px 10px;
  border-radius: @radius-border;
  &:hover {
    background-color: var(--color-primary-background-hover);
  }
  &.active {
    background-color: var(--color-primary-background-active);
  }
  h3 {
    font-size: 15px;
    color: var(--color-font);
    word-break: break-all;
    span {
      font-size: 12px;
      color: var(--color-font-label);
      margin-left: 6px;
    }
  }
  p {
    margin-top: 5px;
    font-size: 14px;
    color: var(--color-font-label);
    word-break: break-all;
  }
}
.dragable {
  cursor: grab;
}
.dragingItem {
  opacity: .5;
}
.primaryTag {
  color: var(--color-primary);
  font-size: 12px;
  margin-right: 6px;
  margin-left: 0 !important;
}
.noitem {
  height: 100px;
  font-size: 18px;
  color: var(--color-font-label);
  display: flex;
  justify-content: center;
  align-items: center;
}
.listLeft {
  flex: auto;
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
}
.listBtn {
  flex: none;
  height: 30px;
  width: 30px;
  padding: 0;
  display: flex;
  svg {
    width: 60%;
  }
}
.note {
  padding: 0 7px;
  margin-top: 15px;
  font-size: 12px;
  line-height: 1.25;
  color: var(--color-font);
  p {
    + p {
      margin-top: 5px;
    }
  }
}
.footer {
  padding: 0 7px;
  margin-top: 15px;
  display: flex;
  flex-flow: row nowrap;
}
.footerBtn {
  flex: auto;
  height: 36px;
  line-height: 36px;
  padding: 0 10px !important;
  width: 150px;
  .mixin-ellipsis-1();
  + .footerBtn {
    margin-left: 15px;
  }
}
.ruleLink {
  .mixin-ellipsis-1();
}

</style>
