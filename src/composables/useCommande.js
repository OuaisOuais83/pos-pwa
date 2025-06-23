import { ref, computed } from 'vue'

const LS_TABLE_KEY = 'pos_table'
const LS_PANIER_KEY = 'pos_panier'
const LS_TICKET_KEY = 'pos_ticket'

const tableId = ref(localStorage.getItem(LS_TABLE_KEY) || null)
const panier = ref(JSON.parse(localStorage.getItem(LS_PANIER_KEY) || '[]'))
const ticket = ref(JSON.parse(localStorage.getItem(LS_TICKET_KEY) || 'null'))

export function useCommande() {
  function persist() {
    localStorage.setItem(LS_TABLE_KEY, tableId.value)
    localStorage.setItem(LS_PANIER_KEY, JSON.stringify(panier.value))
    localStorage.setItem(LS_TICKET_KEY, JSON.stringify(ticket.value))
  }

  function setTable(id) { tableId.value = id; persist() }
  function addProduit(prod) {
    const existing = panier.value.find(i => i.id === prod.id)
    if (existing) existing.quantite++
    else panier.value.push({ id: prod.id, nom: prod.nom, prix: prod.prix, quantite: 1 })
    persist()
  }
  function removeProduit(prodId) { panier.value = panier.value.filter(i => i.id !== prodId); persist() }
  function setQuantite(prodId, qty) { const item = panier.value.find(i => i.id === prodId); if (item) item.quantite = qty; persist() }
  function resetCommande() { tableId.value = null; panier.value = []; ticket.value = null; persist() }
  function simulatePaiement() {
    const produitsCopy = panier.value.map(i => ({ ...i }))
    const total = produitsCopy.reduce((sum, i) => sum + i.prix * i.quantite, 0)
    const date = new Date().toLocaleString('fr-FR')
    ticket.value = { table: tableId.value, produits: produitsCopy, total, date }
    panier.value = []; tableId.value = null; persist()
  }

  const totalItems = computed(() => panier.value.reduce((sum, i) => sum + i.quantite, 0))

  return { tableId, panier, totalItems, ticket, setTable, addProduit, removeProduit, setQuantite, resetCommande, simulatePaiement }
}