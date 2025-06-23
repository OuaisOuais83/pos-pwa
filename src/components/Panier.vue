<template>
  <div class="fixed bottom-0 left-0 w-full bg-gray-800 p-4">
    <div v-if="panier.length">
      <div v-for="item in panier" :key="item.id" class="flex justify-between items-center mb-2">
        <div><span class="text-white">{{item.nom}} x {{item.quantite}}</span></div>
        <div class="flex items-center">
          <button @click="decrease(item.id)" class="px-2">-</button>
          <button @click="increase(item.id)" class="px-2">+</button>
          <button @click="remove(item.id)" class="px-2">🗑️</button>
        </div>
      </div>
      <button @click="goPaiement" class="mt-4 w-full py-2 bg-green-600 text-white rounded-lg">
        Encaisser
      </button>
    </div>
    <div v-else class="text-gray-400 text-center">Panier vide</div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { useCommande } from '@/composables/useCommande'

const router = useRouter()
const { panier, removeProduit, setQuantite } = useCommande()

function increase(id) {
    const item = panier.value.find(i => i.id===id)
    setQuantite(id, item.quantite+1)
}
function decrease(id) {
    const item = panier.value.find(i => i.id===id)
    if(item.quantite>1) setQuantite(id, item.quantite-1)
}
function remove(id) { removeProduit(id) }
function goPaiement() { router.push({ name: 'Paiement' }) }
</script>
