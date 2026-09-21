import Sortable, { AutoScroll } from 'sortablejs/modular/sortable.core.esm'
import { onMounted, watch } from '@common/utils/vueTools'
import { clearDownKeys } from '@renderer/event'

Sortable.mount(new AutoScroll())

const noop = () => {}

export default ({ dom_list, dragingItemClassName, filter, onUpdate, onStart = noop, onEnd = noop }) => {
  let sortable
  let disabledState = true

  const createSortable = () => {
    if (sortable || !dom_list.value) return
    sortable = Sortable.create(dom_list.value, {
      animation: 150,
      disabled: disabledState,
      forceFallback: false,
      filter: filter ? '.' + filter : null,
      ghostClass: dragingItemClassName,
      onUpdate(event) {
        onUpdate(event.newIndex, event.oldIndex)
      },
      onMove(event) {
        return filter ? !event.related.classList.contains(filter) : true
      },
      onChoose() {
        onStart()
      },
      onUnchoose() {
        onEnd()
        // 处于拖动状态期间，键盘事件无法监听，拖动结束手动清理按下的键
        // window.app_event.emit(eventBaseName.setClearDownKeys)
        clearDownKeys()
      },
      onStart(event) {
        window.app_event.dragStart()
      },
      onEnd(event) {
        window.app_event.dragEnd()
      },
    })
  }

  const destroySortable = () => {
    if (!sortable) return
    sortable.destroy()
    sortable = null
  }

  onMounted(createSortable)
  // 容器可能因 v-if/弹窗延迟渲染或反复挂载：出现时创建、销毁时重建（如 Modal 内容随开关挂载）
  watch(dom_list, (el, oldEl) => {
    if (el === oldEl) return
    destroySortable()
    createSortable()
  })

  return {
    setDisabled(enable) {
      disabledState = enable
      if (!sortable) return
      sortable.option('disabled', enable)
    },
  }
}
