<template>
  <div class="flex flex-col h-screen bg-gray-900">
    <header class="px-4 py-3 bg-gray-800 text-white text-lg font-semibold">
      Table : {{ tableId || 'Non définie' }}
    </header>
    <div class="flex-1 overflow-hidden p-4">
      <div class="grid grid-cols-3 gap-2">
        <button v-for="prod in produitsFiltres" :key="prod.id"
                class="bg-gray-700 rounded-lg p-2 flex flex-col items-center justify-center select-none"
                @click="addProduit(prod)"
                @dblclick="openQuantite(prod)">
          <span class="text-sm text-white text-center">{{prod.nom}}</span>
          <span class="text-xs text-gray-300">€{{prod.prix}}</span>
        </button>
      </div>
    </div>
    <nav class="flex justify-around bg-gray-800 p-2">
      <button v-for="cat in categories" :key="cat"
              :class="['py-2 px-4 rounded', categorieActive===cat?'bg-white text-gray-900':'text-white']"
              @click="categorieActive=cat">{{cat}}</button>
    </nav>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useCommande } from '@/composables/useCommande'
import produits from '@/data/produits.json'

const { tableId, addProduit } = useCommande()
const categorieActive = ref(produits[0].categorie)
const categories = [...new Set(produits.map(p => p.categorie))]
const produitsFiltres = computed(() => produits.filter(p => p.categorie===categorieActive.value))

function openQuantite(prod) { /* TODO */ }
</script>
