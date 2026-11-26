<script setup>
import Icon from './Icon.vue'

defineProps({
  visible: Boolean,
  title: { type: String, default: '确认操作' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '确定' },
  cancelText: { type: String, default: '取消' },
  danger: Boolean,
})
const emit = defineEmits(['confirm', 'cancel'])
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="confirm-overlay">
      <div class="confirm-panel">
        <div class="confirm-title">
          <Icon v-if="danger" name="trash" :size="16" style="color: var(--danger); margin-right: 6px; vertical-align: -2px;" />
          {{ title }}
        </div>
        <div v-if="message" class="confirm-message">{{ message }}</div>
        <div class="confirm-actions">
          <button class="btn btn-secondary" @click="emit('cancel')">{{ cancelText }}</button>
          <button :class="['btn', danger ? 'btn-danger' : 'btn-primary']" @click="emit('confirm')">
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
