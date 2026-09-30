# Royaume Maudit — notes de mise à jour

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
