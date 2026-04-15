<template>
  <div class="hello">
    <h1>{{ msg }}</h1>
    <button @click="increment">Count: {{ count }}</button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  msg: string
}>()

const count = ref(0)

const increment = () => {
  count.value++
}
</script>

<style scoped>
.hello {
  text-align: center;
}
</style>
