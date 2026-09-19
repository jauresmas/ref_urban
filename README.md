# Référentiel Urbanisme — MEL

Démonstrateur technique PLU(i) / cadastre / pré-instruction ADS pour la Métropole
Européenne de Lille (couronne ouest : Lille, Capinghem, Englos, Sequedin,
Pérenchies, Prémesques, Ennetières-en-Weppes).

Projet personnel réalisé pour illustrer des compétences de géomaticien
(traitement de données SIG, standards CNIG, réglementation d'urbanisme),
construit sur des données réelles plutôt que des exemples fictifs.

**Ce n'est pas un document officiel.** Les données sont réelles, mais l'outil
n'a aucune valeur légale (non opposable) — voir la mention en bas de carte.

## Fonctionnalités

- Carte de zonage PLUi en SVG (pan/zoom), calques cadastre / bâti / prescriptions / limites communales
- Fiche parcelle au clic : zone, surface, emprise au sol, recul, hauteur
- Détection de proximité aux marges de recul graphiques (prescriptions ponctuelles/linéaires)
- Simulateur de pré-instruction ADS (conformité emprise / hauteur au regard de la zone)
- Module Rapports : statistiques calculées en direct sur les données chargées

## Données et méthode

- **Zonage, cadastre, prescriptions** : PLUi MEL en vigueur et cadastre Etalab/DGFiP, via data.gouv.fr (Licence Ouverte 2.0)
- **Emprise au sol et recul** : valeurs réelles extraites du règlement écrit du PLUi (Livres II, III et IV, ~1100 pages), chapitre par chapitre selon la zone
- **Hauteur** : extraite du plan des hauteurs graphique officiel (GeoPDF géoréférencé par commune), décodé par analyse colorimétrique de sa légende (15 catégories) et échantillonnage par parcelle — réel pour 56 % des parcelles ; le reste renvoie honnêtement au plan graphique plutôt que d'afficher une estimation
- Chaque valeur affichée précise sa source (règlement écrit, plan des hauteurs, ou estimation pédagogique si le chapitre exact n'a pas pu être identifié)

## Stack technique

Aucune dépendance : HTML/CSS/JS vanilla, carte en SVG pur (pas de Leaflet/Mapbox).
Le pipeline de données (extraction PDF, géotraitement, échantillonnage colorimétrique)
a été fait en Python (pypdf, shapely, pymupdf) en amont ; `data.js` contient le résultat
compilé, prêt à l'emploi côté client.

## Lancer en local

Aucune installation nécessaire, juste un serveur statique :

```bash
python -m http.server 8000
```

Puis ouvrir `http://localhost:8000`.
