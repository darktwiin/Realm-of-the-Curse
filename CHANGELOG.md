# Royaume Maudit — notes de mise à jour

## ver.0.0.11 (server.js modifié)
- Nouveau système d'états, avec une icône au-dessus des joueurs et des monstres, et dans le HUD au-dessus de ta barre de vie :
  - paralysé (ne bouge plus) ;
  - empoisonné (dégâts par seconde, les poisons s'additionnent) ;
  - ralenti (sables, ronces, nage, contre-courant…) ;
  - aveuglé (écran noir sauf un petit cercle autour de toi) ;
  - enflammé (lave, attaques de feu) ;
  - enragé (Berserk du guerrier) ;
  - invulnérable ;
  - sonic (chemins, courants dans le bon sens).
- Archer : sa flèche spéciale paralyse les monstres (pas les boss), plus longtemps avec un meilleur carquois. Portée de l'arc ramenée à 10 cases.
- Manoir Hanté : les chauves-souris et les orbes roses du Comte aveuglent.
- Fournaise : les diables cornus, les cerbères et les boules de feu du Seigneur des Abysses enflamment, comme les flammes du Dragon de raid.
- Marais Putride (crapauds, sangsues) et Gardien du Serpent : poison.
- Abysses : la noyade est progressive (1 %, 2 %, 3 %, 5 %, 8 %… de vie par seconde), et une poche d'air apparaît à la mort du Léviathan.
- Jardins Célestes : courants moins forts (-80 % à contre-courant, +90 % dans le sens, ils t'emportent quand même). Les tourbillons violets de la salle du boss deviennent des tremplins qui te propulsent pour esquiver. Éclairs de l'Archange -20 %.
- Les boss des 7 donjons de fin (Manoir, Tombeau, Abysses, Jardins, Fournaise, Caverne, Observatoire) donnent une potion de caractéristique à coup sûr.
- Retour au Royaume après un donjon : 5 s d'invulnérabilité, annulées par ton premier tir.
- Les monstres esquivent 2 fois moins, contournent les murs quand ils ne peuvent pas te toucher, et peuvent maintenant nager.
- Le compteur du prochain boss central n'est plus visible que par les admins.
- Flèche vers le maître des quêtes quand une quête est à récupérer.
- Titre « ADMIN » (réservé aux admins vérifiés par le serveur).
- Maison : 2 nouvelles décorations, le Château des Ombres (très sombre) et le Paradis (tout blanc), à la place de la cabane sylvestre et du sanctuaire astral.
- Marchand réorganisé en 3 rayons (Potions, Familiers, Sacs à dos), cartes plus petites. Nouveaux articles : œuf de familier (300 pièces) et potion de caractéristique du jour (50 pièces, 1 par jour).
- Étang du Nexus au sud du hall : ponton, nénuphars, roseaux et cabane du pêcheur. On y pêche ensemble et on voit la ligne des autres.
- Menu des joueurs : nouvelle option « Inspecter » (équipement, statistiques, monstres tués, prestige, familier…).

## ver.0.0.10 (server.js modifié)
- Familiers entièrement redessinés, avec 2 fois plus de pixels. Chaque rang change vraiment leur look (écharpe, capuche de mage, carapace de lave, crinière de feu, ailes…).
- Tous les boss de donjon redessinés avec 2 fois plus de pixels, y compris les 4 gardiens de l'Observatoire. Chacun a une pose d'attaque et ses propres projectiles : os, chauves-souris, scarabées, bulles, plumes, crânes enflammés, éclats de glace, étoiles, épines, lucioles, rochers, engrenages… Les attaques restent les mêmes.
- On arrive dans le Royaume sur la plage, au bord de la mer.
- Le bord de mer (6 cases) et tous les lacs se traversent à la nage : vitesse réduite, le héros a de l'eau jusqu'à la taille. Les monstres n'y entrent pas.
- Gardien du Prestige dans la maison : il débloque les niveaux 21 à 25 pour tous tes héros (1000 / 2500 / 3500 / 5000 / 6000 prestige). Chaque niveau donne ses statistiques en plus des plafonds.
- La musique de boss continue pendant tout le combat, même si on s'éloigne un moment.
- Assassin : barre bleue sous la vie pour le temps d'invisibilité restant, et les monstres ne semblent plus regagner de vie pendant l'invisibilité.
- Connexion quotidienne : jour 3 = 100 Cursite, jour 5 = 150 Cursite (250 au total, de quoi prendre un skin en promo).
- Historique du chat : Entrée affiche les derniers messages.
- Options : le choix du curseur ne montre plus que le style (la couleur se choisit en dessous).
- Nexus : les statues ne font plus ramer le jeu sur Edge.
- Admin : commande /god, don de pièces aux joueurs, onglet « Admins » qui liste qui a le mode admin en ce moment.

## ver.0.0.9 (server.js modifié)
- Raid de guilde : mourir face au Dragon ne coûte plus rien (ni niveau, ni XP, ni objet). Retour direct au hall de guilde, 45 secondes d'attente avant de pouvoir y retourner.
- 4 donjons intermédiaires (entre le Terrier des Gobelins et les donjons de fin), qui s'ouvrent rarement sur les monstres de la Forêt des Murmures et du Canyon de Rouille :
  - Bosquet des Ronces (la Mère des Ronces) : les ronces ralentissent et piquent.
  - Sanctuaire des Lucioles (le Gardien Luciole) : autels à activer avec E, +30 % de dégâts pendant 20 s.
  - Mine Effondrée (le Contremaître de Pierre) : éboulements annoncés au sol.
  - Forge Rouillée (l'Automate Forgeron) : grilles qui crachent de la vapeur par intermittence.
  - Chaque boss donne à coup sûr une potion de caractéristique aléatoire.
- Royaume 3 fois plus grand, généré au hasard à chaque redémarrage du serveur (même carte pour tous les joueurs).
- Chemins de terre à travers le royaume : +30 % de vitesse dessus.
- Brouillard de guerre sur la minimap : elle se dévoile en explorant (carte entière visible en admin).
- Nouveaux boss centraux, nouveaux sprites et nouvelles attaques : ils n'existent plus au départ. Tous les 20 monstres tués, l'un des deux apparaît au hasard, signalé par un marqueur et une flèche.
- Familiers renommés et redessinés : Rat des brumes, Tortue rouge, Fourmi noire, Lion… Leur sprite évolue à chaque rang au lieu de simplement grossir.
- Correctif : certaines infos envoyées par les joueurs étaient coupées par le serveur (boss, compteur de monstres, donjons).

## ver.0.0.8 (server.js modifié)
- Le Dragon baisse et secoue la tête quand il attaque.
- Nouvelle musique du Dragon, plus posée et orchestrale (taikos, gong, chœurs, cor).
- La lave se traverse mais brûle ; au-delà, une corniche de roche permet de souffler.
- Combat du raid ramené à 5 minutes.
- Projectiles du Dragon en forme de flammes animées, éruptions de feu à la place des éclairs.

## ver.0.0.7 (server.js modifié)
- Nouveau Dragon de Guilde : grand dragon rouge aux ailes battantes, gueule qui crache le feu quand il attaque.
- Le portail s'ouvre au lancement du raid, le Dragon arrive 30 secondes plus tard : grondements, écran qui tremble, rugissement et flash à son apparition.
- Musique épique : tambours de guerre pendant l'attente, puis thème du Dragon (galop de batterie, taikos, chœurs et cuivres).
- Nouvelles attaques de feu : souffle qui balaie l'arène, lignes de flammes qui jaillissent du sol, anneaux de braises, pluie de météores, boules de feu qui explosent. Tout traverse les murs.
- Antre du Dragon : arène bien plus grande, entourée de lave, avec des brasiers et des tas d'or.

## ver.0.0.6 (server.js modifié)
- Le raid de guilde devient un événement de 10 minutes lancé par un admin (bouton dans le panneau admin).
- Nouveau boss : le Dragon de Guilde, 2 fois plus grand, pixels doublés, animation d'attaque (ailes et souffle).
- Le Dragon est invulnérable : chaque guilde fait son maximum de dégâts, classement en direct dans l'arène.
- Ses attaques traversent les murs : souffle en éventail avec des trous, anneau avec une brèche, pluie de météores, double spirale.
- Fin des 10 minutes : le Dragon s'envole et le classement des guildes s'affiche pour tout le monde.
- Récompenses selon la place de la guilde, pour chaque joueur ayant frappé le Dragon.

## ver.0.0.5 (server.js modifié)
- Clic sur le nom d'un joueur dans la liste : menu Groupe, Échange, Duel, Rejoindre, Guilde.
- Groupes (6 joueurs max) : en entrant dans le Royaume, on arrive à côté d'un membre du groupe déjà sur place. Noms des membres en vert.
- Guildes (20 membres) : portail « Guilde » à côté de la maison, création pour 500 pièces, invitation depuis la liste des joueurs, tag affiché devant le pseudo.
- Hall de guilde : feu de camp, bannières, tableau de guilde (membres, dégâts), coffre du raid, portail du raid.
- Raid hebdomadaire : le Titan de la Guilde a une réserve de vie commune pour toute la semaine (1 000 000 PV, +30 % à chaque victoire). Victoire = récompense pour chaque participant au coffre du hall.

## ver.0.0.4
- Un seul œuf de familier : l'ouverture chez l'Éleveur tire l'un des 6 familiers (même chance pour chacun), au tier Commun.
- Évolution dans le parc de la maison : 3 familiers identiques + 1 croquette = 1 familier du tier supérieur (Commun → Rare → Épique).
- Croquette de familier en vente chez le marchand : 500 pièces.
- Chaque tier agrandit le familier : contour lumineux au Rare, couronne à l'Épique.
- Option « Masquer les familiers des autres joueurs ».
- Les anciens œufs deviennent des œufs de familier normaux.

## ver.0.0.3
- Familiers : raretés Commun / Rare / Épique (Ultime bientôt). Plus la rareté est haute, plus le bonus est grand (Rare ×1,6, Épique ×2,4).
- Éclosion façon « ouverture de caisse » chez l'Éleveur : la bande défile et s'arrête sur la rareté obtenue (65 % / 28 % / 7 %).
- Pêche : lac dans la maison (10 poissons d'eau douce) et mer du Royaume depuis la plage (10 poissons de mer). 4 communs, 3 rares, 2 épiques, 1 légendaire par lieu, avec des poids réalistes.
- Tableau de pêche dans la maison : espèces attrapées, record de poids et nombre de prises.

## ver.0.0.2
- Nouvelle statistique **Armure** : retire des dégâts à chaque coup reçu (au moins 15 % passent toujours). Armures lourdes > cuir > robes ; le Guerrier en a le plus de base.
- **Gloire** au niveau 20 : l'XP remplit une jauge dorée ; chaque jauge pleine = 1 point de gloire = +2 prestige à la mort définitive.
- Classement : « Précision » retiré, « Top Prestige gagné » compte tout le prestige gagné depuis le début.
- La salle des coffres devient **ta Maison** : coffres, parc des familiers clôturé et 4 styles de décoration (Chalet, Château, Cabane sylvestre, Sanctuaire astral).
- **Familiers** : 6 œufs (0,1 % sur tous les monstres), l'Éleveur du Nexus les fait éclore. Le familier équipé te suit et augmente une statistique au-delà du maximum ; les autres vivent dans ton parc.

## ver.0.0.1
- Reine des Glaces (Caverne Gelée) moins forte : moins de vie, moins de dégâts, tirs plus espacés.
- Jardins Célestes : contour noir épais autour des projectiles et des éclairs pour mieux les voir.
- Correctif : les monstres d'un donjon ne disparaissent plus quand un joueur meurt ou quitte le donjon.
- Nouvelle touche « Tout ramasser » : G (E sert aux portails). Réglable dans Options > Touches.
- Fin de donjon : retour dans le Royaume, à l'endroit du portail, au lieu du Nexus.
- Numéro de version affiché en bas à gauche de l'écran.
