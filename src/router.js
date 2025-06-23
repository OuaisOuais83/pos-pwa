import { createRouter, createWebHistory } from 'vue-router';
import PlanDeTable from './components/PlanDeTable.vue';
import AccueilProduits from './components/AccueilProduits.vue';
import Panier from './components/Panier.vue';
import Paiement from './components/Paiement.vue';
import Ticket from './components/Ticket.vue';

const routes = [
  { path: '/', name: 'PlanDeTable', component: PlanDeTable },
  { path: '/produits', name: 'AccueilProduits', component: AccueilProduits },
  { path: '/panier', name: 'Panier', component: Panier },
  { path: '/paiement', name: 'Paiement', component: Paiement },
  { path: '/ticket', name: 'Ticket', component: Ticket },
];

export default createRouter({
  history: createWebHistory(),
  routes,
});