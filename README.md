# Référentiel Urbanisme (MEL)

Démonstrateur technique PLU(i) / cadastre / pré-instruction ADS pour la Métropole
Européenne de Lille (couronne ouest : Lille, Capinghem, Englos, Sequedin,
Pérenchies, Prémesques, Ennetières-en-Weppes).

Projet personnel réalisé pour illustrer des compétences de géomaticien
(traitement de données SIG, standards CNIG, réglementation d'urbanisme),
construit sur des données réelles plutôt que des exemples fictifs.

**Démo en ligne :** https://jauresmas.github.io/ref_urban/

**Ce n'est pas un document officiel.** Les données sont réelles, mais l'outil
n'a aucune valeur légale (non opposable), comme l'indique la mention en bas de carte.

## Fonctionnalités

- Carte de zonage PLUi en SVG (pan/zoom), calques cadastre / bâti / prescriptions / limites communales
- Bâti affiché en extrusion pseudo-3D à hauteur réelle (issue du plan des hauteurs, héritée de la parcelle porteuse), sans exagération d'échelle
- Fiche parcelle au clic : zone, surface, emprise au sol, recul, hauteur
- Détection de proximité aux marges de recul graphiques (prescriptions ponctuelles/linéaires)
- Simulateur de pré-instruction ADS (conformité emprise / hauteur au regard de la zone)
- Module Rapports : statistiques calculées en direct sur les données chargées

## Données et méthode

- **Zonage, cadastre, prescriptions** : PLUi MEL en vigueur et cadastre Etalab/DGFiP, via data.gouv.fr (Licence Ouverte 2.0)
- **Emprise au sol et recul** : valeurs réelles extraites du règlement écrit du PLUi (Livres II, III et IV, environ 1100 pages), chapitre par chapitre selon la zone. Un repli pédagogique existe dans le code pour une zone qui n'aurait pas de chapitre identifié, mais il n'est déclenché par aucune parcelle des données actuelles.
- **Hauteur** : extraite du plan des hauteurs graphique officiel (GeoPDF géoréférencé par commune), décodé par analyse colorimétrique de sa légende (15 catégories) et échantillonnage par parcelle. Réel pour 56 % des parcelles ; le reste renvoie honnêtement au plan graphique plutôt que d'afficher une estimation (secteur non géoréférencé de Lille, ou correspondance couleur incertaine). Les bâtiments héritent de la hauteur réelle de leur parcelle porteuse quand elle est connue (54 % des bâtiments) ; sinon une hauteur par défaut leur est affectée, visuellement distincte (opacité réduite)
- Chaque valeur affichée précise sa source exacte (chapitre du règlement écrit, plan des hauteurs, ou repli pédagogique)

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
