<script setup>
import { watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  visible: Boolean,
  src: String,
  alt: { type: String, default: '' },
})
const emit = defineEmits(['close'])

function onKeydown(e) {
  if (e.key === 'Escape' && props.visible) {
    e.preventDefault()
    emit('close')
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) document.addEventListener('keydown', onKeydown)
    else document.removeEventListener('keydown', onKeydown)
  },
  { immediate: true }
)

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="image-preview-mask" @click.self="emit('close')">
      <button class="image-preview-close" type="button" title="关闭（Esc）" @click="emit('close')">
        <Icon name="x" :size="18" />
      </button>
      <img class="image-preview-img" :src="src" :alt="alt" @click.stop />
    </div>
  </Teleport>
</template>

<style scoped>
.image-preview-mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(3px);
  animation: previewFadeIn 0.16s ease;
}
.image-preview-img {
  max-width: 92vw;
  max-height: 88vh;
  object-fit: contain;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
  cursor: default;
}
.image-preview-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s ease;
}
.image-preview-close:hover { background: rgba(255, 255, 255, 0.26); }
@keyframes previewFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
