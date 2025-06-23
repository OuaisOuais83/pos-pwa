<template>
  <div class="flex flex-col items-center justify-center h-screen bg-gray-900 text-white">
    <div v-if="!finished" class="text-lg">Paiement en cours...</div>
    <div v-else class="text-lg">Commande validée !</div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useCommande } from '@/composables/useCommande'

const router = useRouter()
const { simulatePaiement } = useCommande()
const finished = ref(false)

onMounted(() => {
  simulatePaiement()
  setTimeout(() => {
    finished.value = true
    router.push({ name: 'Ticket' })
  }, 1500)
})
</script>
