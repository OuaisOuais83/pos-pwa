<template>
  <div class="flex flex-col h-screen bg-gray-900 text-white p-4">
    <header class="text-xl font-semibold mb-4">Ticket</header>
    <div v-if="ticket">
      <div v-for="item in ticket.produits" :key="item.id" class="flex justify-between mb-2">
        <span>{{item.nom}} x {{item.quantite}}</span>
        <span>€{{item.prix * item.quantite}}</span>
      </div>
      <div class="mt-4 flex justify-between"><span>Total :</span><span>€{{ticket.total}}</span></div>
      <div class="mt-2 text-sm text-gray-400">{{ticket.date}}</div>
    </div>
    <div v-else class="text-gray-400">Aucun ticket à afficher.</div>
  </div>
</template>

<script setup>
import { useCommande } from '@/composables/useCommande'
const { ticket } = useCommande()
</script>
