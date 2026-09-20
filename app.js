(function(){
  "use strict";

  // Échappement HTML pour tout texte injecté via innerHTML et provenant de
  // données externes (cadastre, PLUi) plutôt que codé en dur dans l'appli :
  // ces données sont des sources ouvertes officielles, mais rien ne garantit
  // qu'un champ texte ne contienne jamais de caractères spéciaux.
  function esc(s){
    return String(s==null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  var COMMUNE_NAMES = {'59128':'Capinghem','59195':'Englos','59196':'Ennetières-en-Weppes','59350':'Lille','59457':'Pérenchies','59470':'Prémesques','59566':'Sequedin'};

  var bbox = APP_DATA.meta.bbox; // [minLon,minLat,maxLon,maxLat]
  var REF_LAT = (bbox[1]+bbox[3])/2;
  var COS_REF = Math.cos(REF_LAT*Math.PI/180);
  var M_PER_DEG_LAT = 111320;
  var ORIGIN_LON = bbox[0];
  var ORIGIN_LAT_TOP = bbox[3];

  function project(lon, lat){
    var x = (lon-ORIGIN_LON) * M_PER_DEG_LAT * COS_REF;
    var y = (ORIGIN_LAT_TOP-lat) * M_PER_DEG_LAT;
    return [x,y];
  }

  var VB_W = (bbox[2]-bbox[0]) * M_PER_DEG_LAT * COS_REF;
  var VB_H = (bbox[3]-bbox[1]) * M_PER_DEG_LAT;

  function ringToPath(ring){
    var pts = ring.map(function(p){ return project(p[0],p[1]); });
    return 'M' + pts.map(function(p){ return p[0].toFixed(1)+','+p[1].toFixed(1); }).join('L') + 'Z';
  }
  function lineToPath(line){
    var pts = line.map(function(p){ return project(p[0],p[1]); });
    return 'M' + pts.map(function(p){ return p[0].toFixed(1)+','+p[1].toFixed(1); }).join('L');
  }
  function geomToPath(geom){
    if (geom.type === 'Polygon') return geom.coordinates.map(ringToPath).join(' ');
    if (geom.type === 'MultiPolygon') return geom.coordinates.map(function(poly){ return poly.map(ringToPath).join(' '); }).join(' ');
    if (geom.type === 'LineString') return lineToPath(geom.coordinates);
    if (geom.type === 'MultiLineString') return geom.coordinates.map(lineToPath).join(' ');
    return '';
  }

  function pointInRing(pt, ringProj){
    var inside = false;
    for (var i=0,j=ringProj.length-1; i<ringProj.length; j=i++){
      var xi=ringProj[i][0], yi=ringProj[i][1], xj=ringProj[j][0], yj=ringProj[j][1];
      var intersect = ((yi>pt[1]) !== (yj>pt[1])) && (pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi)+xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function pointInGeom(pt, geom){
    function testPoly(rings){
      var ext = rings[0].map(function(p){ return project(p[0],p[1]); });
      if (!pointInRing(pt, ext)) return false;
      for (var k=1;k<rings.length;k++){
        var hole = rings[k].map(function(p){ return project(p[0],p[1]); });
        if (pointInRing(pt, hole)) return false;
      }
      return true;
    }
    if (geom.type==='Polygon') return testPoly(geom.coordinates);
    if (geom.type==='MultiPolygon') return geom.coordinates.some(testPoly);
    return false;
  }
  function vertexAverage(ring){
    var n = ring.length - 1, sx=0, sy=0;
    for (var i=0;i<n;i++){ sx += ring[i][0]; sy += ring[i][1]; }
    return [sx/n, sy/n];
  }
  // Centroïde géométrique (aire pondérée) — contrairement à la simple moyenne des
  // sommets, il reste correct pour des parcelles allongées ou irrégulières, et évite
  // qu'un point de test tombe dans une zone voisine au lieu de la vraie zone du terrain.
  function ringAreaCentroid(ring){
    var n = ring.length - 1, a=0, cx=0, cy=0;
    for (var i=0;i<n;i++){
      var x0=ring[i][0], y0=ring[i][1], x1=ring[i+1][0], y1=ring[i+1][1];
      var cross = x0*y1 - x1*y0;
      a += cross; cx += (x0+x1)*cross; cy += (y0+y1)*cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-12) return vertexAverage(ring);
    return [cx/(6*a), cy/(6*a)];
  }
  function ringCentroidLonLat(geom){
    var ring = geom.type==='MultiPolygon' ? geom.coordinates[0][0] : geom.coordinates[0];
    var c = ringAreaCentroid(ring);
    // filet de sécurité : si le centroïde calculé tombe hors du polygone (formes
    // concaves), on retente avec la moyenne des sommets, puis un sommet du contour.
    var cProj = project(c[0], c[1]);
    var ringProj = ring.map(function(p){ return project(p[0], p[1]); });
    if (pointInRing(cProj, ringProj)) return c;
    var va = vertexAverage(ring);
    var vaProj = project(va[0], va[1]);
    if (pointInRing(vaProj, ringProj)) return va;
    return ring[0];
  }

  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs){
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  var svg = document.getElementById('map-svg');
  var mapCanvas = document.getElementById('map-canvas');
  var baseMargin = 40; // marge (m) autour des données, rognée par "slice" selon le conteneur
  var vbMinX0 = -baseMargin, vbMinY0 = -baseMargin, vbW0 = VB_W+2*baseMargin, vbH0 = VB_H+2*baseMargin;
  var vx = vbMinX0, vy = vbMinY0, vw = vbW0, vh = vbH0;
  var MIN_W = vbW0*0.10, MAX_W = vbW0; // le zoom arrière ne dépasse jamais l'étendue rectangulaire des données
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');

  function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }

  function clampToRect(){
    vw = clamp(vw, MIN_W, MAX_W);
    vh = vw * (vbH0/vbW0);
    vx = clamp(vx, vbMinX0, Math.max(vbMinX0, vbMinX0+vbW0-vw));
    vy = clamp(vy, vbMinY0, Math.max(vbMinY0, vbMinY0+vbH0-vh));
  }

  function applyViewBox(){
    clampToRect();
    svg.setAttribute('viewBox', vx.toFixed(2)+' '+vy.toFixed(2)+' '+vw.toFixed(2)+' '+vh.toFixed(2));
    updateScaleBar();
  }
  applyViewBox();

  function zoomAt(px, py, factor){
    var newW = clamp(vw*factor, MIN_W, MAX_W);
    var applied = newW/vw;
    if (Math.abs(applied-1) < 1e-6) return;
    vx = px - (px-vx)*applied;
    vy = py - (py-vy)*applied;
    vw = newW; vh = vh*applied;
    applyViewBox();
  }

  svg.addEventListener('wheel', function(ev){
    ev.preventDefault();
    var pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    var svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
    zoomAt(svgP.x, svgP.y, ev.deltaY < 0 ? 0.88 : 1/0.88);
  }, {passive:false});

  document.getElementById('btn-zoom-in').addEventListener('click', function(){
    zoomAt(vx+vw/2, vy+vh/2, 0.8);
  });
  document.getElementById('btn-zoom-out').addEventListener('click', function(){
    zoomAt(vx+vw/2, vy+vh/2, 1.25);
  });
  document.getElementById('btn-zoom-reset').addEventListener('click', function(){
    vx=vbMinX0; vy=vbMinY0; vw=vbW0; vh=vbH0; applyViewBox();
  });

  // ---- pan (drag) ----
  // La capture de pointeur n'est activée qu'au moment où un vrai glissement est
  // détecté (pas dès pointerdown) : sinon un simple clic voit sa cible redirigée
  // vers le <svg> racine et ne touche jamais la parcelle cliquée.
  var isPanning=false, dragMoved=false, dragStartX=0, dragStartY=0, dragVX=0, dragVY=0, dragScale=1, dragPointerId=null;
  svg.addEventListener('pointerdown', function(ev){
    if (ev.button !== undefined && ev.button !== 0) return;
    isPanning = true; dragMoved = false;
    dragStartX = ev.clientX; dragStartY = ev.clientY;
    dragVX = vx; dragVY = vy;
    dragPointerId = ev.pointerId;
    var rect = svg.getBoundingClientRect();
    dragScale = Math.max(rect.width/vw, rect.height/vh);
  });
  svg.addEventListener('pointermove', function(ev){
    if (!isPanning) return;
    var dx = ev.clientX-dragStartX, dy = ev.clientY-dragStartY;
    if (!dragMoved && (Math.abs(dx)>4 || Math.abs(dy)>4)){
      dragMoved = true;
      svg.classList.add('panning');
      try { svg.setPointerCapture(dragPointerId); } catch(e){}
    }
    if (!dragMoved) return;
    vx = dragVX - dx/dragScale;
    vy = dragVY - dy/dragScale;
    applyViewBox();
  });
  function endPan(){
    isPanning = false;
    svg.classList.remove('panning');
  }
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);

  if (window.ResizeObserver){
    new ResizeObserver(function(){ updateScaleBar(); }).observe(mapCanvas);
  } else {
    window.addEventListener('resize', updateScaleBar);
  }

  // ---- render zonage ----
  var gZonage = document.getElementById('layer-zonage');
  APP_DATA.zonage.forEach(function(z, idx){
    var p = el('path', {d: geomToPath(z.geom), 'class':'zone-poly type-'+z.typezone, 'data-idx':idx});
    p.appendChild(el2title(z.libelong || z.libelle));
    gZonage.appendChild(p);
  });
  function el2title(text){
    var t = document.createElementNS(NS,'title');
    t.textContent = text;
    return t;
  }

  // ---- render communes ----
  var gCommunes = document.getElementById('layer-communes');
  APP_DATA.communes.forEach(function(c){
    gCommunes.appendChild(el('path', {d: geomToPath(c.geom), 'class':'commune-line'}));
  });

  // ---- bâti existant : rendu différé (au premier affichage) pour alléger le chargement initial ----
  var gBati = document.getElementById('layer-batiments');
  var batiRendered = false;
  function renderBatimentsOnce(){
    if (batiRendered) return;
    batiRendered = true;
    var frag = document.createDocumentFragment();
    APP_DATA.batiments.forEach(function(b){
      frag.appendChild(el('path', {d: geomToPath(b.geom), 'class':'bati-poly'}));
    });
    gBati.appendChild(frag);
  }

  // ---- render prescriptions ----
  var gPresc = document.getElementById('layer-prescriptions');
  APP_DATA.prescriptions_lineaires.forEach(function(pl){
    var isZac = (pl.libelle||'').indexOf('ZAC') !== -1;
    gPresc.appendChild(el('path', {d: geomToPath(pl.geom), 'class':'presc-line'+(isZac?' zac':'')}));
  });
  // Lignes de "marge de recul" graphique : un recul spécifique à la rue, inscrit
  // au plan, qui prévaut sur la règle générale de zone tant qu'il s'applique.
  var reculLines = [];
  APP_DATA.prescriptions_lineaires.forEach(function(pl){
    if ((pl.libelle||'').indexOf('Marge de recul') !== 0) return;
    var segs = [];
    function addLine(coords){
      var pts = coords.map(function(p){ return project(p[0],p[1]); });
      for (var i=0;i<pts.length-1;i++) segs.push([pts[i][0],pts[i][1],pts[i+1][0],pts[i+1][1]]);
    }
    if (pl.geom.type === 'LineString') addLine(pl.geom.coordinates);
    else if (pl.geom.type === 'MultiLineString') pl.geom.coordinates.forEach(addLine);
    reculLines.push({libelle: pl.libelle, segs: segs});
  });
  function distToSegment(px,py,x1,y1,x2,y2){
    var dx=x2-x1, dy=y2-y1;
    var len2 = dx*dx+dy*dy;
    var t = len2>0 ? ((px-x1)*dx+(py-y1)*dy)/len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx=x1+t*dx, cy=y1+t*dy;
    return Math.hypot(px-cx, py-cy);
  }
  var RECUL_LINE_THRESHOLD = 45; // m — au-delà, on considère que la marge ne concerne pas cette parcelle
  function nearestReculLine(xy){
    var best=null, bestD=Infinity;
    reculLines.forEach(function(rl){
      rl.segs.forEach(function(s){
        var d = distToSegment(xy[0],xy[1],s[0],s[1],s[2],s[3]);
        if (d<bestD){ bestD=d; best=rl; }
      });
    });
    return (best && bestD<=RECUL_LINE_THRESHOLD) ? {libelle:best.libelle, dist:bestD} : null;
  }
  var sanitaryPts = []; // {xy:[x,y], libelle}
  APP_DATA.prescriptions_ponctuelles.forEach(function(pp){
    var xy = project(pp.geom.coordinates[0], pp.geom.coordinates[1]);
    sanitaryPts.push({xy:xy, libelle:pp.libelle});
    gPresc.appendChild(el('circle', {cx:xy[0].toFixed(1), cy:xy[1].toFixed(1), r:3.2, 'class':'presc-point'}));
  });

  // ---- render parcelles ----
  // La zone de chaque parcelle est précalculée côté serveur (Python/shapely) par
  // recouvrement d'aire réel avec le zonage — beaucoup plus fiable qu'un simple test
  // ponctuel côté client, notamment pour les parcelles à cheval sur deux zones
  // (cadastre et zonage PLU sont deux couches indépendantes, leurs limites ne
  // coïncident pas forcément). `pc.zoneSplit` liste alors la répartition réelle.
  var gParcelles = document.getElementById('layer-parcelles');
  var parcelInfo = []; // per index: {centroidXY, zoneIdx}
  APP_DATA.parcelles.forEach(function(pc, idx){
    var path = el('path', {d: geomToPath(pc.geom), 'class':'parcelle-poly', 'data-idx':idx});
    gParcelles.appendChild(path);
    var cLonLat = ringCentroidLonLat(pc.geom);
    var cXY = project(cLonLat[0], cLonLat[1]);
    var zoneIdx = typeof pc.zoneIdx === 'number' ? pc.zoneIdx : -1;
    parcelInfo.push({xy:cXY, zoneIdx: zoneIdx, reculLine: nearestReculLine(cXY)});
  });

  // ---- règlement lookup ----
  // Valeurs réelles extraites du règlement écrit du PLUi MEL (Livre III "Zones
  // constructibles", Livre II "Zones inconstructibles" et Livre IV "Zones
  // spécifiques et de projets publics", version en vigueur du 16/12/2025,
  // consultable sur diffuweb.lillemetropole.fr/PLUi/PLU3). La hauteur maximale
  // n'est pas toujours un chiffre unique par zone dans ce document : dans
  // certaines zones elle est fixée par un "plan des hauteurs" graphique séparé
  // (Reglement_Graphique/Plan_des_hauteurs). Ce plan a été récupéré (GeoPDF
  // géoréférencé, 7 communes) et décodé par analyse colorimétrique (légende à
  // 15 couleurs) pour obtenir la vraie hauteur par parcelle : voir le champ
  // parcelle.hauteurPlan dans data.js. Le secteur nord de Lille n'a pas pu être
  // traité (export sans métadonnées géospatiales côté MEL) ; ces parcelles et
  // celles hors correspondance colorimétrique fiable gardent le renvoi générique
  // au plan graphique plutôt qu'un chiffre inventé.
  var REAL_REGLEMENT = {
    'UCO1.1':   {emprise:60, recul:0},
    'UCO1.1.1': {emprise:75, recul:0},
    'UCO1.2':   {emprise:50, recul:0},
    'UCO2.1':   {emprise:50, recul:0},
    'UCO2.1.1': {emprise:50, recul:0},
    'UCO4.1':   {emprise:40, recul:5},
    'UCO4.1.1': {emprise:40, recul:0},
    'UCO6.1':   {emprise:40, recul:5},
    'UCO7.1':   {emprise:50, recul:0},
    'UCO7.1.1': {emprise:50, recul:0},
    'UCO7.2.1': {emprise:40, recul:0},
    'UVD1.2':   {emprise:40, recul:0},
    'UVD4.2':   {emprise:40, recul:5},
    'UVD6.1':   {emprise:40, recul:5},
    'AUDM':     {emprise:null, recul:5},
    'UE':       {emprise:null, recul:5},
    'UE.1':     {emprise:null, recul:5},
    'UX':       {emprise:null, recul:5},
    'UXr':      {emprise:null, recul:5},
    'UAL':      {emprise:null, recul:5, hauteur:22},
    'UP':       {emprise:null, recul:5, hauteurLabel:'Non réglementée'},
    'UEP':      {emprise:null, recul:'flex'},
    'UEP.1':    {emprise:null, recul:'flex'},
    'AUCM':     {emprise:50, recul:'flex'},
    'AUCA':     {emprise:70, recul:'flex', hauteur:22}
  };
  var RECUL_LABELS = {
    0:"Implantation possible à l'alignement (pas de retrait imposé)",
    'flex':"À l'alignement ou en retrait volontaire (pas de minimum chiffré)"
  };
  var LIVRE_IV_ZONES = {'UAL':1, 'UP':1, 'UEP':1, 'UEP.1':1, 'UE.1':1};

  function reglementFor(zone){
    if (!zone) return null;
    var tz = zone.typezone, lib = zone.libelle || '';
    if (tz === 'A') return {constructible:false, motif:"Zone agricole (A) : constructions limitées aux exploitations agricoles"};
    if (tz === 'N') return {constructible:false, motif:"Zone naturelle et forestière (N) : constructions limitées aux aménagements légers"};

    var real = REAL_REGLEMENT[lib];
    if (real){
      var livre = LIVRE_IV_ZONES[lib] ? 'Livre IV (zones spécifiques et de projets publics)' : 'Livre III/II';
      return {
        constructible:true, real:true,
        emprise: real.emprise, recul: real.recul, hauteur: real.hauteur || null,
        hauteurLabel: real.hauteurLabel || null,
        reculLabel: RECUL_LABELS[real.recul] || (real.recul+' m par rapport à l\'alignement'),
        source:"Règlement écrit du PLUi MEL, "+livre+", chapitre "+lib,
        note: (tz==='AUc'||tz==='AUs') ? "Ouverture à l'urbanisation soumise à orientation d'aménagement (OAP)" : null
      };
    }
    // Repli pédagogique : chapitre non retrouvé automatiquement dans le règlement écrit.
    if (tz === 'AUc' || tz === 'AUs') return {constructible:true, emprise:40, recul:5, estim:true, note:"Ouverture à l'urbanisation soumise à orientation d'aménagement (OAP)"};
    if (lib.indexOf('UEP') === 0) return {constructible:true, emprise:40, recul:5, estim:true};
    if (lib.indexOf('UE') === 0 || lib.indexOf('UX') === 0) return {constructible:true, emprise:null, recul:5, estim:true};
    return {constructible:true, emprise:50, recul:5, estim:true};
  }

  // ---- selection & panels ----
  var selectedIdx = null;
  var ficheEl = document.getElementById('fiche-parcelle');
  var simEl = document.getElementById('pre-instruction');
  var gLink = document.getElementById('layer-link');

  function nearestSanitary(xy){
    var best=null, bestD=Infinity;
    sanitaryPts.forEach(function(s){
      var d = Math.hypot(s.xy[0]-xy[0], s.xy[1]-xy[1]);
      if (d<bestD){ bestD=d; best=s; }
    });
    return best ? {point:best, dist:bestD} : null;
  }

  function selectParcel(idx){
    var prevSel = gParcelles.querySelector('.parcelle-poly.selected');
    if (prevSel) prevSel.classList.remove('selected');
    var path = gParcelles.querySelector('[data-idx="'+idx+'"]');
    if (path) path.classList.add('selected');
    selectedIdx = idx;

    var pc = APP_DATA.parcelles[idx];
    var info = parcelInfo[idx];
    var zone = info.zoneIdx>=0 ? APP_DATA.zonage[info.zoneIdx] : null;
    var reg = reglementFor(zone);
    var communeNom = COMMUNE_NAMES[pc.commune] || pc.commune;
    var hp = pc.hauteurPlan || null;
    var hpNumeric = hp && hp.a!=null ? hp.a : null;

    var refHtml = '<div class="ref-line">'+esc(communeNom)+' · '+esc(pc.section)+' '+esc(pc.numero)+'</div>';
    var zoneHtml = zone
      ? '<div class="zone-line">Zone '+esc(zone.libelle)+' : '+esc(zone.libelong||'')+'</div>'
      : '<div class="zone-line">Zone non déterminée</div>';

    var splitHtml = '';
    if (pc.zoneSplit){
      var parts = pc.zoneSplit.map(function(s){
        var z = APP_DATA.zonage[s[0]];
        return esc(z ? z.libelle : '?') + ' (' + Math.round(s[1]*100) + '%)';
      });
      splitHtml = '<div class="zone-split-note"><span class="label">Parcelle à cheval sur plusieurs zones</span>'+parts.join(' · ')+
        '. La zone dominante ('+Math.round(pc.zoneSplit[0][1]*100)+'% de la surface) est retenue ci-dessous ; le cadastre et le zonage sont deux couches indépendantes dont les limites ne coïncident pas toujours.</div>';
    }

    var attrs = '';
    attrs += attrRow('Surface cadastrale', pc.contenance ? Math.round(pc.contenance).toLocaleString('fr-FR')+' m²' : '—');
    var footnote;
    if (reg && reg.constructible){
      var hauteurDisplay, hauteurNote;
      if (hpNumeric != null){
        hauteurDisplay = hpNumeric+' m (absolue)'+(hp.f!=null ? ', '+hp.f+' m (façade)' : ', façade non réglementée');
        hauteurNote = 'Hauteur : valeur réelle extraite du plan des hauteurs graphique du PLUi (analyse colorimétrique du plan officiel géoréférencé), indépendante du règlement écrit. ';
      } else if (hp && hp.s === 'NR'){
        hauteurDisplay = 'Non réglementée (plan des hauteurs)';
        hauteurNote = 'Hauteur : le plan des hauteurs graphique du PLUi n\'indique aucun plafond à cet endroit. ';
      } else if (reg.hauteur || reg.hauteurLabel){
        hauteurDisplay = reg.hauteur ? reg.hauteur+' m' : reg.hauteurLabel;
        hauteurNote = (hp && hp.s === 'AH') ? 'Le plan des hauteurs renvoie ici au règlement de zone ci-dessus. ' : '';
      } else {
        hauteurDisplay = 'Cf. plan des hauteurs (annexe graphique)';
        hauteurNote = 'La hauteur maximale n\'est pas un chiffre unique par zone dans ce règlement : elle est fixée par un plan des hauteurs graphique séparé, non exploité pour cette parcelle (hors emprise des plans traités ou correspondance couleur incertaine). ';
      }
      attrs += attrRow('Hauteur max.', hauteurDisplay);
      attrs += attrRow('Emprise au sol', reg.emprise==null ? 'Non réglementée' : reg.emprise+'% max');
      attrs += attrRow('Recul voirie', reg.reculLabel || (reg.recul+' m par rapport à l\'alignement'));
      if (hp && hp.s === 'NC'){
        attrs += '<div class="zone-split-note"><span class="label">Plan des hauteurs</span>Ce plan graphique marque cet emplacement « non constructible » ; à vérifier sur le plan officiel — cette parcelle reste par ailleurs en zone constructible au titre du zonage PLUi ci-dessus.</div>';
      }
      if (info.reculLine){
        attrs += '<div class="zone-split-note"><span class="label">Marge de recul graphique à proximité</span>'+
          esc(info.reculLine.libelle)+' (à '+Math.round(info.reculLine.dist)+' m du centre de la parcelle) : cette prescription, inscrite au plan, prévaut sur la règle générale de zone ci-dessus si elle s\'applique à cette parcelle. Sa valeur exacte en mètres n\'est pas numérisée dans les données ouvertes ; il faut la vérifier sur le plan de zonage officiel.</div>';
      }
      footnote = reg.real
        ? '<p class="legend-note">Emprise et recul : valeurs réelles extraites du règlement écrit du PLUi (source : '+reg.source+'). '+hauteurNote+'</p>'
        : '<p class="legend-note">Chapitre non retrouvé automatiquement dans le règlement écrit du PLUi pour cette zone : l\'emprise et le recul indiqués ici sont des valeurs pédagogiques d\'estimation, pas des valeurs opposables. '+hauteurNote+'</p>';
    } else if (reg){
      attrs += attrRow('Constructibilité', reg.motif);
    }
    var near = nearestSanitary(info.xy);
    if (near){
      attrs += attrRow('Ouvrage assainissement le plus proche', Math.round(near.dist)+' m');
    }

    ficheEl.innerHTML = refHtml + zoneHtml + splitHtml + attrs +
      (reg && reg.note ? '<p class="legend-note">'+reg.note+'</p>' : '') +
      (footnote || '');

    // link line to nearest sanitary point
    gLink.innerHTML = '';
    if (near){
      gLink.appendChild(el('line', {
        x1:info.xy[0].toFixed(1), y1:info.xy[1].toFixed(1),
        x2:near.point.xy[0].toFixed(1), y2:near.point.xy[1].toFixed(1),
        'class':'link-line'
      }));
      gLink.appendChild(el('circle', {cx:info.xy[0].toFixed(1), cy:info.xy[1].toFixed(1), r:3, 'class':'link-dot'}));
    }

    var regForSim = reg;
    if (reg && hpNumeric != null){
      regForSim = Object.assign({}, reg, {hauteur: hpNumeric});
    }
    renderSimulator(regForSim);
  }

  function attrRow(label, value){
    return '<div class="attr-row"><span>'+label+'</span><span>'+value+'</span></div>';
  }

  var simBadgeEl = document.getElementById('sim-badge');
  function updateSimBadge(reg){
    if (!simBadgeEl) return;
    if (reg && reg.real){
      simBadgeEl.textContent = 'Valeurs réelles du règlement';
      simBadgeEl.title = reg.source;
    } else if (reg && reg.constructible){
      simBadgeEl.textContent = 'Estimation pédagogique';
      simBadgeEl.title = "Chapitre non retrouvé automatiquement dans le règlement écrit : valeurs approximatives.";
    } else {
      simBadgeEl.textContent = 'Simulation';
      simBadgeEl.title = '';
    }
  }

  function renderSimulator(reg){
    updateSimBadge(reg);
    if (!reg){
      simEl.innerHTML = '<p class="empty-state">Zone non déterminée pour cette parcelle.</p>';
      return;
    }
    if (!reg.constructible){
      simEl.innerHTML =
        '<div class="check-row"><span class="dot bad"></span><span class="lbl">Zone constructible</span><span class="val">Non</span></div>'+
        verdictHtml('NON CONSTRUCTIBLE','bad','Simulation, non opposable');
      return;
    }
    if (reg.emprise == null){
      simEl.innerHTML =
        '<p class="empty-state">Emprise au sol non réglementée dans cette zone : il n\'y a aucun seuil à vérifier.</p>'+
        '<div class="check-row"><span class="dot ok"></span><span class="lbl">Zone constructible</span><span class="val">Oui</span></div>'+
        verdictHtml('CONFORME','ok','Simulation, non opposable');
      return;
    }
    var defE = Math.max(5, reg.emprise-10);
    var hauteurField = reg.hauteur
      ? '<div class="sim-field"><label>Hauteur projet (m)</label><input type="number" id="in-hauteur" value="'+Math.max(1,reg.hauteur-2)+'" min="0" step="0.5"></div>'
      : '';
    simEl.innerHTML =
      '<div class="sim-fields-row">'+
        hauteurField+
        '<div class="sim-field"><label>Emprise projet (%)</label><input type="number" id="in-emprise" value="'+defE+'" min="0" max="100" step="1"></div>'+
      '</div>'+
      '<div id="checks"></div>';
    document.getElementById('in-emprise').addEventListener('input', function(){ updateVerdict(reg); });
    if (reg.hauteur) document.getElementById('in-hauteur').addEventListener('input', function(){ updateVerdict(reg); });
    updateVerdict(reg);
  }

  function updateVerdict(reg){
    var e = parseFloat(document.getElementById('in-emprise').value) || 0;
    var hEl = document.getElementById('in-hauteur');
    var h = hEl ? (parseFloat(hEl.value) || 0) : null;
    var eOk = e <= reg.emprise;
    var hOk = (h==null) ? true : (h <= reg.hauteur);
    var checksHtml =
      '<div class="check-row"><span class="dot ok"></span><span class="lbl">Zone constructible</span><span class="val">Oui</span></div>'+
      (h!=null ? '<div class="check-row"><span class="dot '+(hOk?'ok':'bad')+'"></span><span class="lbl">Hauteur ≤ '+reg.hauteur+' m</span><span class="val">'+h+' m</span></div>' : '')+
      '<div class="check-row"><span class="dot '+(eOk?'ok':'bad')+'"></span><span class="lbl">Emprise ≤ '+reg.emprise+'%</span><span class="val">'+e+'%</span></div>';
    var allOk = eOk && hOk;
    document.getElementById('checks').innerHTML = checksHtml +
      verdictHtml(allOk?'CONFORME':'NON CONFORME', allOk?'ok':'bad', 'Simulation, non opposable');
  }

  function verdictHtml(title, cls, sub){
    return '<div class="verdict-stamp '+cls+'"><div class="v-title">'+title+'</div><div class="v-sub">'+sub+'</div></div>';
  }

  gParcelles.addEventListener('click', function(ev){
    if (dragMoved) { dragMoved = false; return; }
    var t = ev.target;
    if (t && t.hasAttribute('data-idx')) selectParcel(parseInt(t.getAttribute('data-idx'),10));
  });

  document.getElementById('btn-new-instruction').addEventListener('click', function(){
    var prevSel = gParcelles.querySelector('.parcelle-poly.selected');
    if (prevSel) prevSel.classList.remove('selected');
    selectedIdx = null;
    gLink.innerHTML = '';
    ficheEl.innerHTML = '<p class="empty-state">Sélectionnez une parcelle sur le plan.</p>';
    simEl.innerHTML = '<p class="empty-state">Sélectionnez d\'abord une parcelle.</p>';
  });

  // ---- layer toggles ----
  document.querySelectorAll('.layer-row input').forEach(function(cb){
    cb.addEventListener('change', function(){
      var layer = cb.getAttribute('data-layer');
      var map = {zonage:'layer-zonage', prescriptions:'layer-prescriptions', parcelles:'layer-parcelles', batiments:'layer-batiments', communes:'layer-communes'};
      var g = document.getElementById(map[layer]);
      if (layer === 'batiments' && cb.checked) renderBatimentsOnce();
      if (g) g.style.display = cb.checked ? '' : 'none';
    });
  });

  // ---- top nav tabs ----
  document.querySelectorAll('.main-nav button').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.main-nav button').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      var tab = btn.getAttribute('data-tab');
      ['zonage','instructions','rapports'].forEach(function(name){
        document.getElementById('view-'+name).hidden = (name !== tab);
      });
      if (tab === 'rapports') renderRapportsOnce();
    });
  });

  // ---- rapports (calculés en direct sur les données chargées) ----
  var rapportsRendered = false;

  function ringArea(ring){
    var pts = ring.map(function(p){ return project(p[0],p[1]); });
    var a = 0;
    for (var i=0;i<pts.length-1;i++) a += pts[i][0]*pts[i+1][1] - pts[i+1][0]*pts[i][1];
    return Math.abs(a)/2;
  }
  function polygonArea(geom){
    if (geom.type === 'Polygon') return geom.coordinates.reduce(function(sum,ring,i){ return sum + (i===0 ? ringArea(ring) : -ringArea(ring)); }, 0);
    if (geom.type === 'MultiPolygon') return geom.coordinates.reduce(function(sum,poly){ return sum + polygonArea({type:'Polygon',coordinates:poly}); }, 0);
    return 0;
  }

  function renderRapportsOnce(){
    if (rapportsRendered) return;
    rapportsRendered = true;

    // -- superficie de zonage par famille --
    var famArea = {}; // family key -> m2
    var famOrder = ['U','AUc','AUs','A','N'];
    APP_DATA.zonage.forEach(function(z){
      var key = famOrder.indexOf(z.typezone) >= 0 ? z.typezone : z.typezone;
      famArea[key] = (famArea[key]||0) + polygonArea(z.geom);
    });
    // fusionne AUc + AUs sous un seul "AU"
    var famMerged = {U: famArea.U||0, AU: (famArea.AUc||0)+(famArea.AUs||0), A: famArea.A||0, N: famArea.N||0};
    var famTotal = famMerged.U+famMerged.AU+famMerged.A+famMerged.N;
    var famColors = {U:'var(--zone-u)', AU:'var(--zone-au)', A:'var(--zone-a)', N:'var(--zone-n)'};
    var famLabels = {U:'U : Urbaines', AU:'AU : À urbaniser', A:'A : Agricole', N:'N : Naturelle'};
    var famRows = ['U','AU','A','N'].map(function(k){ return {k:k, ha: famMerged[k]/10000}; }).sort(function(a,b){ return b.ha-a.ha; });
    var maxHa = Math.max.apply(null, famRows.map(function(r){ return r.ha; }));
    var zonageHtml = famRows.map(function(r){
      var pct = famTotal>0 ? (famMerged[r.k]/famTotal*100) : 0;
      var w = maxHa>0 ? (r.ha/maxHa*100) : 0;
      return '<div class="bar-row"><span class="bar-label">'+famLabels[r.k]+'</span>'+
        '<span class="bar-track"><span class="bar-fill" style="width:'+w.toFixed(1)+'%;background:'+famColors[r.k]+'"></span></span>'+
        '<span class="bar-val">'+r.ha.toFixed(1)+' ha ('+pct.toFixed(0)+'%)</span></div>';
    }).join('');
    document.getElementById('rap-zonage-chart').innerHTML = zonageHtml +
      '<p class="rap-note">Superficie calculée à partir des polygones de zonage PLUi chargés (mêmes couleurs que la légende du plan).</p>';

    // -- parcelles par commune --
    var byCommune = {}; // code -> {count, surface}
    APP_DATA.parcelles.forEach(function(pc){
      var c = byCommune[pc.commune] || (byCommune[pc.commune] = {count:0, surface:0});
      c.count++; c.surface += (pc.contenance||0);
    });
    var communeRows = Object.keys(byCommune).map(function(code){
      return {code:code, nom: COMMUNE_NAMES[code]||code, count: byCommune[code].count, surface: byCommune[code].surface};
    }).sort(function(a,b){ return b.count-a.count; });
    var maxCount = Math.max.apply(null, communeRows.map(function(r){ return r.count; }));
    var communeHtml = communeRows.map(function(r){
      var w = maxCount>0 ? (r.count/maxCount*100) : 0;
      return '<div class="bar-row"><span class="bar-label">'+esc(r.nom)+'</span>'+
        '<span class="bar-track"><span class="bar-fill" style="width:'+w.toFixed(1)+'%;background:var(--ink)"></span></span>'+
        '<span class="bar-val">'+r.count.toLocaleString('fr-FR')+'</span></div>';
    }).join('');
    document.getElementById('rap-commune-chart').innerHTML = communeHtml;

    // -- vue d'ensemble --
    var totalParcelles = APP_DATA.parcelles.length;
    var totalSurface = communeRows.reduce(function(s,r){ return s+r.surface; }, 0) / 10000;
    var totalZones = APP_DATA.zonage.length;
    var splitCount = APP_DATA.parcelles.filter(function(pc){ return !!pc.zoneSplit; }).length;
    document.getElementById('rap-overview').innerHTML =
      '<div class="rap-stats">'+
        statTile(totalParcelles.toLocaleString('fr-FR'), 'Parcelles cadastrales') +
        statTile(totalSurface.toFixed(0)+' ha', 'Surface cadastrale totale') +
        statTile(String(totalZones), 'Zones PLUi distinctes') +
        statTile(communeRows.length+'/7', 'Communes couvertes') +
      '</div>'+
      (splitCount ? '<p class="rap-note">'+splitCount+' parcelle'+(splitCount>1?'s':'')+' à cheval sur plusieurs zones du PLUi (voir fiche parcelle).</p>' : '');

    // -- constructibilité --
    var cCount=0, ncCount=0, undet=0;
    APP_DATA.parcelles.forEach(function(pc){
      var idx = pc.zoneIdx;
      if (typeof idx !== 'number' || idx<0){ undet++; return; }
      var tz = APP_DATA.zonage[idx].typezone;
      if (tz==='A' || tz==='N') ncCount++; else cCount++;
    });
    var totC = cCount+ncCount+undet;
    document.getElementById('rap-constructible').innerHTML = splitBar([
      {label:'Constructible', count:cCount, color:'var(--ok)'},
      {label:'Non constructible (A/N)', count:ncCount, color:'var(--bad)'},
      {label:'Zone non déterminée', count:undet, color:'var(--hairline)'}
    ], totC);

    // -- couverture du règlement écrit --
    var realCount=0, estimCount=0;
    APP_DATA.parcelles.forEach(function(pc){
      var idx = pc.zoneIdx;
      if (typeof idx !== 'number' || idx<0) return;
      var zone = APP_DATA.zonage[idx];
      var reg = reglementFor(zone);
      if (!reg || !reg.constructible) return;
      if (reg.real) realCount++; else estimCount++;
    });
    var totReg = realCount+estimCount;
    document.getElementById('rap-couverture').innerHTML = splitBar([
      {label:'Valeurs réelles du règlement', count:realCount, color:'var(--ink)'},
      {label:'Estimation pédagogique', count:estimCount, color:'var(--ink-faint)'}
    ], totReg) + '<p class="rap-note">Calculé sur les parcelles en zone constructible uniquement (hors A/N et zones non déterminées).</p>';
  }

  function statTile(num, lbl){
    return '<div class="rap-stat"><div class="num">'+num+'</div><div class="lbl">'+lbl+'</div></div>';
  }
  function splitBar(segments, total){
    var bar = '<div class="split-bar">'+segments.map(function(s){
      var w = total>0 ? (s.count/total*100) : 0;
      return w>0 ? '<span class="seg" style="width:'+w.toFixed(2)+'%;background:'+s.color+'"><title>'+s.label+' : '+s.count+'</title></span>' : '';
    }).join('')+'</div>';
    var legend = '<div class="split-legend">'+segments.map(function(s){
      var pct = total>0 ? (s.count/total*100) : 0;
      return '<span class="item"><span class="swatch" style="background:'+s.color+'"></span>'+s.label+' : '+s.count.toLocaleString('fr-FR')+' ('+pct.toFixed(0)+'%)</span>';
    }).join('')+'</div>';
    return bar+legend;
  }

  // ---- scale bar ----
  function updateScaleBar(){
    var rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var vb = svg.viewBox.baseVal;
    var pxPerMeter = Math.max(rect.width/vb.width, rect.height/vb.height);
    var candidates = [10,20,25,50,100,200,250,500];
    var chosen = candidates[0];
    for (var i=0;i<candidates.length;i++){
      chosen = candidates[i];
      if (candidates[i]*pxPerMeter >= 60) break;
    }
    document.getElementById('scale-bar').style.width = (chosen*pxPerMeter).toFixed(0)+'px';
    document.getElementById('scale-label').textContent = chosen+' m';
  }
  window.addEventListener('resize', updateScaleBar);
  setTimeout(updateScaleBar, 60);

  // ---- initial demo selection: pick a plausible parcel inside a U zone ----
  (function pickDefault(){
    for (var i=0;i<APP_DATA.parcelles.length;i++){
      var info = parcelInfo[i];
      if (info.zoneIdx>=0){
        var z = APP_DATA.zonage[info.zoneIdx];
        var c = APP_DATA.parcelles[i].contenance;
        if (z.typezone==='U' && c>150 && c<900){
          selectParcel(i);
          return;
        }
      }
    }
    // fallback: first parcel with a determined zone
    for (var j=0;j<APP_DATA.parcelles.length;j++){
      if (parcelInfo[j].zoneIdx>=0){ selectParcel(j); return; }
    }
  })();

})();
